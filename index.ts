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
import { ImgPool, MarkerPool } from './pools.js';

// The markerClusterer library is loaded from CDN, as window.marketClusterer.
// The following workaround is to give it strong typing.
import { authFetch, dbGet, dbPut, escapeHtml, exchangeCodeForToken, FetchError } from './utils.js';

/**
 * ONEDRIVE INTEGRATION AND CREDENTIALS: CODE FLOW WITH PKCE
 * 1. The user navigates to "index.html" and we offer a login button, which they click.
 * 2. We locally invent a challenge and verifier. We store the verifier in sessionStorage,
 *    and redirect the user to a Microsoft-owned signin page with that challenge.
 *    Upon signin, they get redirected back to this page "index.html" but with ?code=...
 * 3. We redeem that code into an access token and refresh token, by making a fetch call
 *    (not a redirect) to a Microsoft endpoint, sending the code and the verifier.
 *    At this point we'll remove the verifier from sessionStorage.
 * 4. We store the access_token in localStorage, and use it any time we want to make a request.
 * 5. We also store the refresh_token in localStorage. If we ever find that the access
 *    token is expired (typically because we get back a 401 Unauthorized response)
 *    then we make another fetch call to a Microsoft endpoint to get another
 *    access token and refresh token, which we again store in localStorage.
 * 6. If ever a user visits index.html again and we have access_token in localStorage,
 *    we'll try it! and if that doesn't work, we'll try to refresh it.
 *    If the refresh has been revoked, then we remove both from localStorage.
 */
const CLIENT_ID = 'e5461ba2-5cd4-4a14-ac80-9be4c017b685'; // onedrive microsoft ID for my app, "GEOPIC", used to sign into Onedrive
localStorage.setItem('client_id', CLIENT_ID);

// Following are initialized in onBodyLoad()
let MAP: google.maps.Map;
let MARKER_POOL: MarkerPool;
let IMG_POOL: ImgPool;


/**
 * Sets up authentication and UI.
 * - If we have local cache of geoData, we set up map, thumbnails, histogram
 * - If we have a ?code= param from OAuth2 redirect, we redeem it for tokens and proceed.
 * - We attempt to fetch the Photos folder, to learn if the access_token is valid or can
 *   be refreshed, and if the local cache is up to date.
 * - We display instructions based on login and staleness.
 */
export async function onBodyLoad(): Promise<void> {
    MAP = (document.getElementById("map")! as google.maps.MapElement).innerMap;
    MARKER_POOL = await MarkerPool.create(MAP);
    IMG_POOL = new ImgPool(document.getElementById('thumbnails-grid')!);

    // Set up map, thumbnails, histogram
    const localCache = await dbGet<GeoData>();
    if (localCache) await displayAndManageInteractions(localCache);

    // Dispatch ?code=... param from OAuth2 redirect
    const code = new URLSearchParams(new URL(location.href).search).get('code');
    if (code) {
        const code_verifier = sessionStorage.getItem('code_verifier')!;
        sessionStorage.removeItem('code_verifier');
        const r = await exchangeCodeForToken(CLIENT_ID, code, code_verifier);
        if (r instanceof FetchError) {
            console.error(r.message);
        } else {
            localStorage.setItem('access_token', r.accessToken);
            localStorage.setItem('refresh_token', r.refreshToken);
        }
        window.history.replaceState(null, '', window.location.pathname);
    }

    // Attempt to get Pictures metadata (so validating access token) and validate local cache. Outcomes:
    // - (!accessToken, !geoData, !status) -- user is signed out, no geo data
    // - (!accessToken, geoData, !status) -- user is signed out, geo data from local, we don't know if it's fresh or stale
    // - (accessToken, !geoData, !status) -- user is signed in but no geo data has ever been generated
    // - (accessToken, geoData, fresh|stale) -- user is signed in, geo data from most recent onedrive generation
    let photosDriveItem: any | null = null;
    document.getElementById('instructions')!.innerHTML = '<span class="spinner"></span> checking OneDrive for updates...';
    const r = await authFetch('https://graph.microsoft.com/v1.0/me/drive/special/photos?select=size');
    try { if (r.ok) photosDriveItem = await r.json(); } catch { }

    const status = photosDriveItem && localCache ? (localCache.size === photosDriveItem.size ? 'fresh' : 'stale') : undefined;

    // Update UI elements
    let instructions = 'Geopic';
    if (status === 'fresh') {
        instructions = `Geopic. ${localCache?.geoItems.length} photos <span title="logout" id="logout">⏏</span>`;
    } else if (status === 'stale') {
        instructions = 'Geopic. <span id="generate">Ingest all new photos...</span> <span title="logout" id="logout">⏏</span>';
    } else if (localStorage.getItem('access_token')) {
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
 * Handles the login button click event with OAuth2 PKCE code-flow:
 * - sets up code_challenge and code_verifier
 * - stores the latter in sessionStorage where the response to index.html?code=... will find it (so as to redeem the code)
 * - redirects to the Microsoft login page, with a redirect back to index.html?code=...
 */
export async function onLoginClick(): Promise<void> {
    const base64url = (array: Uint8Array): string => btoa(String.fromCharCode.apply(null, Array.from<number>(array))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const code_verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const code_challenge = base64url(new Uint8Array((await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code_verifier)))));
    sessionStorage.setItem('code_verifier', code_verifier);

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: window.location.origin + window.location.pathname,
        scope: 'files.readwrite offline_access',
        code_challenge,
        code_challenge_method: 'S256'
    });
    location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
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
    const sw = (MAP.getZoom() || 0) <= 2 ? { lat: -90, lng: -179.9999 } : { lat: bounds.getSouthWest().lat(), lng: bounds.getSouthWest().lng() };
    const ne = (MAP.getZoom() || 0) <= 2 ? { lat: 90, lng: 179.9999 } : { lat: bounds.getNorthEast().lat(), lng: bounds.getNorthEast().lng() };
    const [clusters, tally] = asClusters(sw, ne, MAP.getDiv().offsetWidth, geoData, filter);

    clusters.sort((a, b) => b.totalPassFilterItems - a.totalPassFilterItems)
    for (const cluster of clusters) {
        const item = cluster.somePassFilterItems.length > 0 ? cluster.somePassFilterItems[0] : cluster.oneFailFilterItem!;
        const imgClassName = cluster.totalPassFilterItems === 0 ? 'filtered-out' : filter.text ? 'filter-glow' : '';
        const spanText = cluster.totalPassFilterItems <= 1 ? undefined : cluster.totalPassFilterItems.toString();
        const onClick = () => MAP.fitBounds(new google.maps.LatLngBounds(cluster.bounds.sw, cluster.bounds.ne));
        const marker = MARKER_POOL.add(item.thumbnailUrl, imgClassName, spanText, onClick);
        marker.position = item.position;
        marker.zIndex = cluster.totalPassFilterItems;
    }
    MARKER_POOL.finishAdding();


    for (const item of clusters.flatMap(c => c.somePassFilterItems).slice(0, 200)) {
        const img = IMG_POOL.addImg(item.thumbnailUrl);
        img.onclick = async () => {
            const r = await authFetch(`https://graph.microsoft.com/v1.0/me/drive/items/${item.id}?select=webUrl`);
            if (!r.ok) throw new FetchError(r, await r.text());
            const url = (await r.json()).webUrl;
            window.open(url, 'geopic-image');
        };
    }
    IMG_POOL.finishAdding();

    return tally;
}

/**
 * This function is called when the user clicks the "Generate" button.
 * It does a recursive walk of the user's OneDrive Photos folder,
 * and uploads the resulting geo.json file, and updates the link.
 */
export async function onGenerateClick(): Promise<void> {
    instruct(`<span class="spinner"></span> Ingesting photos...<br/>A full index takes ~30mins for 100,000 photos on a good network; incremental updates will finish in just seconds. If you reload this page, it will pick up where it left off. <pre id="progress">[...preparing bulk indexer...]</pre>`);
    const r = await authFetch('https://graph.microsoft.com/v1.0/me/drive/special/photos');
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
    const geoData = await generateImpl(progress, photosDriveItem);
    await dbPut(geoData);
    instruct('Geopic <span title="logout" id="logout">⏏</span>');
}



