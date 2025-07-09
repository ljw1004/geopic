/**
 * This single-page html+js app combines your OneDrive photos with an embedded Google Map.
 * Each photo with known latitude and longitude is shown as a "AdvancedMarkerElement" on the google map,
 * and it uses google's MarkerClusterer to group them together if there are too many.
 * If you click on a cluster, then each individual matching thumbnail will be shown below the map.
 * A sidebar includes a date-range filter, and freeform text filter.
 * 
 * For scanning, we expect about 30-40 top-level folders with 20-40 subfolders within each one.
 * It takes OneDrive about about 1s to retrieve a folder's child listing.
 */

// Google Maps type imports
/// <reference types="google.maps" />
import { generateImpl, GeoData, asClusters, GeoItem, boundsForDateRange, Filter, Tally } from './geoitem.js';
import { Histogram } from './histogram.js';

// The markerClusterer library is loaded from CDN, as window.marketClusterer.
// The following workaround is to give it strong typing.
import { dbGet, dbPut, escapeHtml, FetchError } from './utils.js';

/**
 * ONEDRIVE INTEGRATION AND CREDENTIALS.
 * 1. Upon first use, user navigates to the page "index.html"
 * 2. The user clicks the Login button, which takes them to a Microsoft-own signin page, then upon signin
 *    they get redirected back to this page with query-params ?access_token=...
 * 3. So, if this page is loaded with those query-params in the URL, we can proceed to offer onedrive functionality
 *    via the Microsoft Graph API.
 * 4. We store the query-params in cookies so that if the user navigates to index.html without query params
 *    BUT their cookies are still valid (as evinced by a successful query for PHOTOS_FOLDER_ID), 
 *    then we can still proceed with OneDrive access.
 */
const CLIENT_ID = 'e5461ba2-5cd4-4a14-ac80-9be4c017b685'; // onedrive microsoft ID for my app, "GEOPIC", used to sign into Onedrive

let MAP: google.maps.Map; // initialized in onBodyLoad()
let MARKER_POOL: MarkerPool; // initialized in onBodyLoad()


/**
 * Sets up authentication and UI by:
 * (1) checking for a OneDrive access token via query-params and cookies,
 * (2) checking whether that access token is still good,
 * (3) updating visibility of various page elements based on whether access token is still good,
 *     and whether a geo.json file already exists
 * 
 * INVARIANT: at the end of this function,
 * 1. The localStorage item 'access_token' is set to a valid access token, or removed if not valid.
 * 2. The important document element IDs (geo, generate, logout, login) have correct visibility.
 */
export async function onBodyLoad(): Promise<void> {
    MAP = (document.getElementById("map")! as google.maps.MapElement).innerMap;
    MARKER_POOL = await MarkerPool.create(MAP);

    // 1. First priority is to display local data if it exists, as quick as we can
    // This is also where we wire up events from map and histogram
    const localCache = await dbGet<GeoData>();
    if (localCache) {
        await displayAndManageInteractions(localCache);
    }

    // 2. Then, at our leisure, we figure out login status and stateleness
    let accessToken = new URLSearchParams(new URL(location.href).hash.replace(/^#/, '')).get("access_token");
    if (accessToken) {
        localStorage.setItem('access_token', accessToken);
    } else {
        accessToken = localStorage.getItem('access_token');
    }

    // 3. Attempt to get geoData, and validate access token. Outcomes:
    // - (!accessToken, !geoData, !status) -- user is signed out, no geo data
    // - (!accessToken, geoData, !status) -- user is signed out, geo data from local, we don't know if it's fresh or stale
    // - (accessToken, !geoData, !status) -- user is signed in but no geo data has ever been generated
    // - (accessToken, geoData, fresh|stale) -- user is signed in, geo data from most recent onedrive generation
    let status: 'fresh' | 'stale' | undefined;
    let photosDriveItem: any | null = null;
    if (accessToken) {
        document.getElementById('instructions')!.innerHTML = '<span class="spinner"></span> checking OneDrive for updates...';
        const r = await fetch('https://graph.microsoft.com/v1.0/me/drive/special/photos?select=size', { 'headers': { 'Authorization': `Bearer ${accessToken}` } });
        try { if (r.ok) photosDriveItem = await r.json(); } catch { }
    }

    if (!photosDriveItem) {
        localStorage.removeItem('access_token');
        accessToken = null;
    } else if (localCache) {
        status = localCache.size === photosDriveItem.size ? 'fresh' : 'stale';
    }

    // 4. Update UI elements
    let instructions = 'Geopic';
    if (status === 'fresh') {
        instructions = `Geopic. ${localCache?.geoItems.length} photos <span title="logout" id="logout">⏏</span>`;
    } else if (status === 'stale') {
        instructions = 'Geopic. <span id="generate">Ingest all new photos...</span> <span title="logout" id="logout">⏏</span>';
    } else if (accessToken) {
        instructions = '<span id="generate">Index your photo collection...</span> <span title="logout" id="logout">⏏</span>';
    } else if (localCache) {
        instructions = '<span id="login">Login to OneDrive to look for updates...</span>';
    } else {
        instructions = '<span id="login">Login to OneDrive to index your photos...</span>';
    }
    instruct(instructions);

}

async function displayAndManageInteractions(geoData: GeoData): Promise<void> {
    const HISTOGRAM = new Histogram(document.getElementById("histogram-container")!);
    const TEXT_FILTER = document.getElementById('text-filter') as HTMLInputElement;
    const MAP = (document.getElementById("map")! as google.maps.MapElement).innerMap;


    let userHasMapWork = false;
    let boundsChangedByCode = false;
    let filter: Filter = { dateRange: undefined, text: undefined };

    MAP.addListener('bounds_changed', () => {
        if (!boundsChangedByCode) userHasMapWork = Boolean(filter.dateRange);
        const tally = calcTallyAndRenderGeo(geoData, filter);
        HISTOGRAM.setData(tally);
    });

    MAP.addListener('idle', () => boundsChangedByCode = false);

    HISTOGRAM.onSelectionChange = (selection) => {
        filter.dateRange = selection;
        if (filter.dateRange && !userHasMapWork) {
            const newBounds = boundsForDateRange(geoData, filter.dateRange);
            if (newBounds) {
                boundsChangedByCode = true;
                MAP.fitBounds(new google.maps.LatLngBounds(newBounds.sw, newBounds.ne));
                return;
            }
        }
        const tally = calcTallyAndRenderGeo(geoData, filter);
        HISTOGRAM.setData(tally);
    };

    TEXT_FILTER.addEventListener('input', () => {
        const text = TEXT_FILTER.value.trim().toLowerCase();
        filter.text = text ? text : undefined;
        TEXT_FILTER.classList.toggle('filter-glow', Boolean(text));
        const tally = calcTallyAndRenderGeo(geoData, filter);
        HISTOGRAM.setData(tally);
    });

    TEXT_FILTER.placeholder = 'Filter, e.g. Person or 2024/03';

    const tally = calcTallyAndRenderGeo(geoData, filter);
    HISTOGRAM.setData(tally);
}


function instruct(instructions: string): void {
    instructions += '<br/><span id="clear">Clear cache...</span>';
    document.getElementById('instructions')!.innerHTML = instructions;
    document.getElementById('login')?.addEventListener('click', onLoginClick);
    document.getElementById('logout')?.addEventListener('click', onLogoutClick);
    document.getElementById('generate')?.addEventListener('click', onGenerateClick);
    document.getElementById('clear')?.addEventListener('click', onClearClick);
}

async function onClearClick(): Promise<void> {
    await dbPut(null);
    location.reload();
}

/**
 * Handles the login button click event.
 * Redirects the user to Microsoft OAuth2 login page with appropriate permissions.
 * After successful login, Microsoft will redirect back to this page with access token.
 */
export function onLoginClick(): void {
    location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${CLIENT_ID}&scope=files.readwrite&response_type=token&redirect_uri=${location.href}`;
}

/**
 * Handles the logout button click event.
 */
export function onLogoutClick(): void {
    localStorage.removeItem('access_token');
    location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/logout?post_logout_redirect_uri=${location.href}`;
}

function calcTallyAndRenderGeo(geoData: GeoData, filter: Filter): Tally {
    const bounds = MAP.getBounds()!;
    const sw = { lat: bounds.getSouthWest().lat(), lng: bounds.getSouthWest().lng() };
    const ne = { lat: bounds.getNorthEast().lat(), lng: bounds.getNorthEast().lng() };
    const [clusters, tally] = asClusters(sw, ne, MAP.getDiv().offsetWidth, geoData, filter);

    clusters.sort((a, b) => b.totalPassFilterItems - a.totalPassFilterItems)
    for (const cluster of clusters) {
        const item = cluster.somePassFilterItems.length > 0 ? cluster.somePassFilterItems[0] : cluster.oneFailFilterItem!;
        const imgClassName = cluster.totalPassFilterItems === 0 ? 'filtered-out' : filter.text ? 'filter-glow' : '';
        const spanText = cluster.totalPassFilterItems <= 1 ? undefined : cluster.totalPassFilterItems.toString();
        const onClick = () => MAP.fitBounds(new google.maps.LatLngBounds(cluster.bounds.sw, cluster.bounds.ne));
        const marker = MARKER_POOL.addMarker(item.thumbnailUrl, imgClassName, spanText, onClick);
        marker.position = item.position;
        marker.zIndex = cluster.totalPassFilterItems;
    }
    MARKER_POOL.finishAddingMarkers();

    const thumbnailsDiv = document.getElementById('thumbnails-grid')!;
    thumbnailsDiv.innerHTML = '';
    for (const item of clusters.flatMap(c => c.somePassFilterItems).slice(0, 40)) {
        const img = document.createElement('img');
        img.src = item.thumbnailUrl;
        img.loading = 'lazy';
        img.addEventListener('click', async () => {
            const accessToken = localStorage.getItem('access_token');
            if (!accessToken) return;
            const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${item.id}?select=webUrl`, { 'headers': { 'Authorization': `Bearer ${accessToken}` } });
            if (!r.ok) throw new FetchError(r, await r.text());
            const url = (await r.json()).webUrl;
            window.open(url, 'geopic-image');
        });
        thumbnailsDiv.appendChild(img);
    }

    return tally;
}

/**
 * This function is called when the user clicks the "Generate" button.
 * It does a recursive walk of the user's OneDrive Photos folder,
 * and uploads the resulting geo.json file, and updates the link.
 */
export async function onGenerateClick(): Promise<void> {
    instruct(`<span class="spinner"></span> Ingesting photos...<br/>A full index takes ~30mins for 100,000 photos on a good network; incremental updates will finish in just seconds. If you reload this page, it will pick up where it left off. <pre id="progress">[...preparing bulk indexer...]</pre>`);
    const accessToken = localStorage.getItem('access_token')!;
    const r = await fetch('https://graph.microsoft.com/v1.0/me/drive/special/photos', { 'headers': { 'Authorization': `Bearer ${accessToken}` } });
    if (!r.ok) {
        const reason = await r.text();
        console.error(reason);
        instruct(`Error! Try <span id="logout">logging out</span> and then try again.<pre>${escapeHtml(reason)}</pre>`);
        return;
    }

    const temporaryGeoData: GeoData = {
        schemaVersion: 0,
        id: '',
        size: 0,
        lastModifiedDateTime: '',
        cTag: '',
        eTag: '',
        immediateChildCount: 0,
        folders: [],
        geoItems: [],
    };

    function progress(update: string[] | GeoItem[]): void {
        if (update.length === 0) return;
        if (typeof update[0] === 'string') {
            document.getElementById('progress')!.textContent = [`${temporaryGeoData.geoItems.length} photos so far`, ...update].join('\n');
        } else {
            temporaryGeoData.geoItems.push(...update as GeoItem[]);
            calcTallyAndRenderGeo(temporaryGeoData, { dateRange: undefined, text: undefined });
        }
    }

    const photosDriveItem = await r.json();
    const geoData = await generateImpl(progress, accessToken, photosDriveItem);
    await dbPut(geoData);
    instruct('Geopic <span title="logout" id="logout">⏏</span>');
}



/**
 * INVARIANTS:
 * - 'img' only contains markers that have content=<img/>
 * - 'span' only contains markers that have content=<div><img/><span/></div>
 * - the key is equal to the img src
 * - if and only if we added a click handler, we stored it in the listener field
 */
type Markers = {
    img: Map<string, { marker: google.maps.marker.AdvancedMarkerElement, listener: google.maps.MapsEventListener | undefined }>,
    span: Map<string, { marker: google.maps.marker.AdvancedMarkerElement, listener: google.maps.MapsEventListener | undefined }>,
}

/**
 * This class is a factory for image markers that belong to a google map,
 * specifically for the case where the caller needs to refresh the entire
 * list of markers on the map in one go. Each marker contains either
 * content=<img/>, or content=<div><img/><span/></div>.
 * Under the hood it's optimized to avoid dynamic allocation of markers or DOM elements.
 * 
 * How to use: any time the caller wants to refresh all markers on the map,
 * it calls addMarker() for each one, then finishAddingMarkers() when done.
 * (Implicitly, the first addMarker() after finishAddingMarkers() implies
 * a fresh batch of markers).
 * 
 * Pooling strategy... It's easier to think of this procedurally. Think of a
 * steady 'finished' state where we store a list of markers, some of which are on
 * the map and some of which are unused. Then our refresh procedure starts, so all
 * the ones which used to be on the map are set aside in a "potential for immediate
 * reuse" area. One by one our refresh procedure adds markers to the map, either
 * taking them from this immediate-reuse pool if they're an exact match, or taking
 * them from the unused pool, or creating entirely new ones if none are available.
 * At the end of the refresh procedure, everything left in this immediate-reuse pool
 * gets moved into the unused pool, and our steady state has been restored.
 * 
 * The refresh procedure start is implicit in the first call to addMarker() after
 * the previous finishAddingMarkers(). The refresh proceceure end happens when
 * we call finishAddingMarkers(). If finishAddingMarkers() was called without
 * any preceding addMarkers(), then that means the refresh procedure started and
 * finished with no markers. (This is to support the case where no markers are wanted!)
 */
export class MarkerPool {
    public state: {
        kind: 'finished',
        onMap: Markers, // all have .map=container
        unused: Markers, // all have .map=null, and listeners undefined
    } | {
        kind: 'adding',
        forImmediateReuse: Markers, // all have .map=container
        onMap: Markers, // all have .map=container
        unused: Markers, // all have .map=null, and listeners undefined
    }

    public static async create(map: google.maps.Map): Promise<MarkerPool> {
        const markerLibrary = await google.maps.importLibrary("marker") as google.maps.MarkerLibrary;
        return new MarkerPool(markerLibrary, map);
    }

    private constructor(private MARKER_LIBRARY: google.maps.MarkerLibrary, private MAP: google.maps.Map) {
        this.state = {
            kind: 'finished',
            onMap: { img: new Map(), span: new Map() },
            unused: { img: new Map(), span: new Map() },
        }
    }

    private static startAddingIfNeeded(state: MarkerPool['state']): Extract<MarkerPool['state'], { kind: 'adding' }> {
        if (state.kind === 'adding') return state;
        return {
            kind: 'adding',
            forImmediateReuse: state.onMap,
            onMap: { img: new Map(), span: new Map() },
            unused: state.unused,
        };
    }

    /**
     * Obtains a new marker, belonging to the map passed in the constructor.
     * The marker will have content either <img/> or <div><img/><span/></div>
     * depending on whether spanText was passed. The img will have the specified
     * src and imgClassName (use empty string for none). The marker will have a click listener
     * if specified. The caller is expected to .setPosition() and .setZIndex() as needed.
     */
    public addMarker(src: string, imgClassName: string, spanText: undefined | string, onClick: undefined | (() => void)): google.maps.marker.AdvancedMarkerElement {
        this.state = MarkerPool.startAddingIfNeeded(this.state);

        // The following code has several branches. They all establish some invariants:
        // - marker is defined
        // - marker.map === this.MAP
        // - marker.content is either <img/> or <div><img/><span/></div> according to spanText

        // Step 1. Attempt to reuse from immediate-reuse pool with exact matching src
        const key = spanText === undefined ? 'img' : 'span';
        let markerAndListener = this.state.forImmediateReuse[key].get(src);
        if (markerAndListener) {
            this.state.forImmediateReuse[key].delete(src);
            // assuming invariant that forImmediateReuse has map=container
            // assuming invariant that forImmediateReuse[key] has correct content type
        } else {
            // Step 2. Failing that, pick the oldest marker from the unused pool (even with different src)
            const firstEntry = this.state.unused[key].entries().next();
            if (!firstEntry.done) {
                const oldSrc = firstEntry.value[0];
                markerAndListener = firstEntry.value[1];
                this.state.unused[key].delete(oldSrc);
                markerAndListener.marker.map = this.MAP; // because unused has map=null
                // assuming invariant that unused[key] has correct content type
            } else {
                const img = document.createElement('img');
                img.loading = 'lazy';
                let content: HTMLElement;
                if (key === 'img') {
                    content = img;
                } else {
                    content = document.createElement('div');
                    content.appendChild(img);
                    const badge = document.createElement('span');
                    content.appendChild(badge);
                }
                const marker = new this.MARKER_LIBRARY.AdvancedMarkerElement({ map: this.MAP, content });
                markerAndListener = { marker, listener: undefined };
                // here we're establishing the invariants
            }
        }

        // Now establish the invariant that marker has no listener that we installed
        // Assuming invariant that Markers.listener is any listener that we installed.
        const { marker, listener: oldListener } = markerAndListener;
        oldListener?.remove();

        // Now we'll set up its content, per our parameters
        let img: HTMLImageElement;
        if (spanText === undefined) {
            img = marker.content as HTMLImageElement;
        } else {
            const div = marker.content as HTMLDivElement;
            img = div.children[0] as HTMLImageElement;
            const span = div.children[1] as HTMLSpanElement;
            span.textContent = spanText;
        }
        if (img.src !== src) img.src = src;
        if (img.className !== imgClassName) img.className = imgClassName;
        const listener = onClick ? marker.addListener('click', onClick) : undefined;

        // Final book-keeping. We've established all the invariants described in Markers type.
        this.state.onMap[key].set(src, { marker, listener });
        return marker;
    }

    /**
     * Removes all markers from the map, except for those that were added by
     * addMarker() since the last call to finishAddingMarkers().
     */
    public finishAddingMarkers(): void {
        // In case the user called finishAddingMarkers() twice without any intervening addMarkers()
        // to denote a map devoid of markers, we have to enter 'adding' state ourselves.
        const { onMap, forImmediateReuse, unused } = MarkerPool.startAddingIfNeeded(this.state);

        // Any remaining markers in immediate-reuse pool are moved to unused-pool
        // We're modifying by reference the same 'unused' that we got by destructuring earlier.
        for (const key of ['img', 'span'] as const) {
            for (const [src, { marker, listener }] of forImmediateReuse[key]) {
                marker.map = null; // establish the invariant for unused, that map=null
                listener?.remove(); // establish the invariant for unused, that listener is undefined
                // other invariants (about content-type and key) carry over
                unused[key].set(src, { marker, listener: undefined });
            }
        }

        this.state = { kind: 'finished', onMap, unused };
    }
}

