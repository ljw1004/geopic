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
import { generateImpl, asClusters, boundsForDateRange } from './geoitem.js';
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
/**
 * GOOGLE MAPS INTEGRATION.
 * We need to keep this list ourselves, since google's Map object doesn't give them to us.
 */
let MARKERS = [];
let MARKER_LIBRARY;
let MAP;
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
export async function onBodyLoad() {
    MARKER_LIBRARY = await google.maps.importLibrary("marker");
    MAP = document.getElementById("map").innerMap;
    // 1. First priority is to display local data if it exists, as quick as we can
    // This is also where we wire up events from map and histogram
    const localCache = await dbGet();
    if (localCache) {
        displayAndManageInteractions(localCache);
    }
    // 2. Then, at our leisure, we figure out login status and stateleness
    let accessToken = new URLSearchParams(new URL(location.href).hash.replace(/^#/, '')).get("access_token");
    if (accessToken) {
        localStorage.setItem('access_token', accessToken);
    }
    else {
        accessToken = localStorage.getItem('access_token');
    }
    // 3. Attempt to get geoData, and validate access token. Outcomes:
    // - (!accessToken, !geoData, !status) -- user is signed out, no geo data
    // - (!accessToken, geoData, !status) -- user is signed out, geo data from local, we don't know if it's fresh or stale
    // - (accessToken, !geoData, !status) -- user is signed in but no geo data has ever been generated
    // - (accessToken, geoData, fresh|stale) -- user is signed in, geo data from most recent onedrive generation
    let status;
    let photosDriveItem = null;
    if (accessToken) {
        document.getElementById('instructions').innerHTML = '<span class="spinner"></span> checking OneDrive for updates...';
        const r = await fetch('https://graph.microsoft.com/v1.0/me/drive/special/photos?select=size', { 'headers': { 'Authorization': `Bearer ${accessToken}` } });
        try {
            if (r.ok)
                photosDriveItem = await r.json();
        }
        catch { }
    }
    if (!photosDriveItem) {
        localStorage.removeItem('access_token');
        accessToken = null;
    }
    else if (localCache) {
        status = localCache.size === photosDriveItem.size ? 'fresh' : 'stale';
    }
    // 4. Update UI elements
    let instructions = 'Geopic';
    if (status === 'fresh') {
        instructions = `Geopic. ${localCache?.geoItems.length} photos <span title="logout" id="logout">⏏</span>`;
    }
    else if (status === 'stale') {
        instructions = 'Geopic. <span id="generate">Ingest all new photos...</span> <span title="logout" id="logout">⏏</span>';
    }
    else if (accessToken) {
        instructions = '<span id="generate">Index your photo collection...</span> <span title="logout" id="logout">⏏</span>';
    }
    else if (localCache) {
        instructions = '<span id="login">Login to OneDrive to look for updates...</span>';
    }
    else {
        instructions = '<span id="login">Login to OneDrive to index your photos...</span>';
    }
    instruct(instructions);
}
function displayAndManageInteractions(geoData) {
    const HISTOGRAM = new Histogram(document.getElementById("histogram-container"));
    const TEXT_FILTER = document.getElementById('text-filter');
    let userHasMapWork = false;
    let boundsChangedByCode = false;
    let filter = { dateRange: undefined, text: undefined };
    MAP.addListener('bounds_changed', () => {
        if (!boundsChangedByCode)
            userHasMapWork = Boolean(filter.dateRange);
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
function instruct(instructions) {
    instructions += '<br/><span id="clear">Clear cache...</span>';
    document.getElementById('instructions').innerHTML = instructions;
    document.getElementById('login')?.addEventListener('click', onLoginClick);
    document.getElementById('logout')?.addEventListener('click', onLogoutClick);
    document.getElementById('generate')?.addEventListener('click', onGenerateClick);
    document.getElementById('clear')?.addEventListener('click', onClearClick);
}
async function onClearClick() {
    await dbPut(null);
    location.reload();
}
/**
 * Handles the login button click event.
 * Redirects the user to Microsoft OAuth2 login page with appropriate permissions.
 * After successful login, Microsoft will redirect back to this page with access token.
 */
export function onLoginClick() {
    location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${CLIENT_ID}&scope=files.readwrite&response_type=token&redirect_uri=${location.href}`;
}
/**
 * Handles the logout button click event.
 */
export function onLogoutClick() {
    localStorage.removeItem('access_token');
    location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/logout?post_logout_redirect_uri=${location.href}`;
}
function calcTallyAndRenderGeo(geoData, filter) {
    for (const marker of MARKERS)
        marker.map = null;
    MARKERS = [];
    const bounds = MAP.getBounds();
    const sw = { lat: bounds.getSouthWest().lat(), lng: bounds.getSouthWest().lng() };
    const ne = { lat: bounds.getNorthEast().lat(), lng: bounds.getNorthEast().lng() };
    const [clusters, tally] = asClusters(sw, ne, MAP.getDiv().offsetWidth, geoData, filter);
    clusters.sort((a, b) => b.totalPassFilterItems - a.totalPassFilterItems);
    for (const cluster of clusters) {
        const item = cluster.somePassFilterItems.length > 0 ? cluster.somePassFilterItems[0] : cluster.oneFailFilterItem;
        let content;
        const img = document.createElement('img');
        img.src = item.thumbnailUrl;
        img.loading = 'lazy';
        if (cluster.totalPassFilterItems === 0) {
            img.className = 'filtered-out';
        }
        else if (filter.text) {
            img.className = 'filter-glow';
        }
        if (cluster.totalPassFilterItems <= 1) {
            content = img;
            content.title = item.date.toString();
        }
        else {
            content = document.createElement('div');
            content.title = `${cluster.totalPassFilterItems} photos`;
            content.appendChild(img);
            const badge = document.createElement('span');
            badge.textContent = cluster.totalPassFilterItems.toString();
            content.appendChild(badge);
        }
        const marker = new MARKER_LIBRARY.AdvancedMarkerElement({ map: MAP, content, position: item.position, zIndex: cluster.totalPassFilterItems });
        marker.addListener('click', () => MAP.fitBounds(new google.maps.LatLngBounds(cluster.bounds.sw, cluster.bounds.ne)));
        MARKERS.push(marker);
    }
    const thumbnailsDiv = document.getElementById('thumbnails-grid');
    thumbnailsDiv.innerHTML = '';
    for (const item of clusters.flatMap(c => c.somePassFilterItems).slice(0, 40)) {
        const img = document.createElement('img');
        img.src = item.thumbnailUrl;
        img.loading = 'lazy';
        img.addEventListener('click', async () => {
            const accessToken = localStorage.getItem('access_token');
            if (!accessToken)
                return;
            const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${item.id}?select=webUrl`, { 'headers': { 'Authorization': `Bearer ${accessToken}` } });
            if (!r.ok)
                throw new FetchError(r, await r.text());
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
export async function onGenerateClick() {
    instruct(`<span class="spinner"></span> Ingesting photos...<br/>A full index takes ~30mins for 100,000 photos on a good network; incremental updates will finish in just seconds. If you reload this page, it will pick up where it left off. <pre id="progress">[...preparing bulk indexer...]</pre>`);
    const accessToken = localStorage.getItem('access_token');
    const r = await fetch('https://graph.microsoft.com/v1.0/me/drive/special/photos', { 'headers': { 'Authorization': `Bearer ${accessToken}` } });
    if (!r.ok) {
        const reason = await r.text();
        console.error(reason);
        instruct(`Error! Try <span id="logout">logging out</span> and then try again.<pre>${escapeHtml(reason)}</pre>`);
        return;
    }
    const temporaryGeoData = {
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
    function progress(update) {
        if (update.length === 0)
            return;
        if (typeof update[0] === 'string') {
            document.getElementById('progress').textContent = [`${temporaryGeoData.geoItems.length} photos so far`, ...update].join('\n');
        }
        else {
            temporaryGeoData.geoItems.push(...update);
            calcTallyAndRenderGeo(temporaryGeoData, { dateRange: undefined, text: undefined });
        }
    }
    const photosDriveItem = await r.json();
    const geoData = await generateImpl(progress, accessToken, photosDriveItem);
    await dbPut(geoData);
    instruct('Geopic <span title="logout" id="logout">⏏</span>');
}
//# sourceMappingURL=index.js.map