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
import { generateImpl, asClusters } from './geoitem.js';
// The markerClusterer library is loaded from CDN, as window.marketClusterer.
// The following workaround is to give it strong typing.
import { dbGet, dbPut, FetchError } from './utils.js';
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
    // 1. Get access_token from query-params or localStorage
    const url = new URL(location.href);
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    let accessToken = params.get("access_token");
    if (accessToken) {
        localStorage.setItem('access_token', accessToken);
    }
    else {
        accessToken = localStorage.getItem('access_token');
    }
    // 2. Attempt to get geoData, and validate access token. Outcomes:
    // - (!accessToken, !geoData, !status) -- user is signed out, no geo data
    // - (!accessToken, geoData, !status) -- user is signed out, geo data from local, we don't know if it's fresh or stale
    // - (accessToken, !geoData, !status) -- user is signed in but no geo data has ever been generated
    // - (accessToken, geoData, fresh|stale) -- user is signed in, geo data from most recent onedrive generation
    let geoData = null;
    let status;
    const [localCache, driveItem] = await Promise.all([
        dbGet(),
        accessToken ? fetch('https://graph.microsoft.com/v1.0/me/drive/special/photos', { 'headers': { 'Authorization': `Bearer ${accessToken}` } }).then(async (r) => {
            try {
                return r.ok ? await r.json() : undefined;
            }
            catch {
                return undefined;
            }
        }) : Promise.resolve(undefined)
    ]);
    if (!driveItem) {
        localStorage.removeItem('access_token');
        accessToken = null;
        geoData = localCache || null;
        status = undefined;
    }
    else if (localCache && localCache.size === driveItem.size) {
        geoData = localCache;
        status = 'fresh';
    }
    else {
        const onedriveCache = await fetch(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/index.json:/content`, { 'headers': { 'Authorization': `Bearer ${accessToken}` } }).then(async (r) => r.ok ? await r.json() : null);
        if (onedriveCache) {
            await dbPut(onedriveCache);
            geoData = onedriveCache;
        }
        else {
            geoData = localCache || null;
        }
        status = geoData ? (geoData.size === driveItem.size ? 'fresh' : 'stale') : undefined;
    }
    // 3. Update UI elements based on authentication state
    document.getElementById('login').style.display = accessToken ? 'none' : 'inline';
    document.getElementById('logout').style.display = accessToken ? 'inline' : 'none';
    document.getElementById('generate').style.display = accessToken ? 'inline' : 'none';
    if (geoData) {
        const markerLibrary = await google.maps.importLibrary("marker");
        const map = document.getElementById("map").innerMap;
        renderGeo(geoData, map, markerLibrary);
        map.addListener('bounds_changed', () => renderGeo(geoData, map, markerLibrary));
    }
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
function renderGeo(geoData, map, markerLibrary) {
    for (const marker of MARKERS)
        marker.map = null;
    MARKERS = [];
    const bounds = map.getBounds();
    const sw = { lat: bounds.getSouthWest().lat(), lng: bounds.getSouthWest().lng() };
    const ne = { lat: bounds.getNorthEast().lat(), lng: bounds.getNorthEast().lng() };
    const clusters = asClusters(sw, ne, map.getDiv().offsetWidth, geoData.geoItems);
    for (const cluster of clusters) {
        const item = cluster.someItems[0];
        const content = document.createElement('div');
        content.style.position = 'relative';
        content.title = cluster.totalItems > 1 ? `${cluster.totalItems} photos` : `${item.date}`;
        const img = document.createElement('img');
        img.src = item.thumbnailUrl;
        img.loading = 'lazy';
        img.style.width = item.aspectRatio >= 1 ? '80px' : `${80 * item.aspectRatio}px`;
        img.style.height = item.aspectRatio < 1 ? '80px' : `${80 / item.aspectRatio}px`;
        img.style.border = '1px solid white';
        img.style.borderRadius = '5px';
        content.appendChild(img);
        const badge = document.createElement('div');
        badge.textContent = cluster.totalItems === 1 ? '' : cluster.totalItems.toString();
        badge.style.position = 'absolute';
        badge.style.top = '-5px';
        badge.style.right = '-5px';
        badge.style.backgroundColor = 'rgba(21, 132, 199, 0.9)';
        badge.style.color = 'white';
        badge.style.fontWeight = 'bold';
        badge.style.fontSize = '12px';
        badge.style.padding = '2px 6px';
        badge.style.borderRadius = '12px';
        badge.style.border = '1px solid white';
        content.appendChild(badge);
        const marker = new markerLibrary.AdvancedMarkerElement({ map, content, position: item.position, zIndex: cluster.totalItems });
        marker.addListener('click', () => map.fitBounds(new google.maps.LatLngBounds(cluster.bounds.sw, cluster.bounds.ne)));
        MARKERS.push(marker);
    }
    const thumbnailsDiv = document.getElementById('thumbnails');
    thumbnailsDiv.innerHTML = '';
    for (const item of clusters.flatMap(c => c.someItems).splice(0, 400)) {
        const img = document.createElement('img');
        img.src = item.thumbnailUrl;
        img.style.width = item.aspectRatio >= 1 ? '100px' : `${100 * item.aspectRatio}px`;
        img.style.height = item.aspectRatio < 1 ? '100px' : `${100 / item.aspectRatio}px`;
        img.title = item.date;
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
}
/**
 * This function is called when the user clicks the "Generate" button.
 * It does a recursive walk of the user's OneDrive Photos folder,
 * and uploads the resulting geo.json file, and updates the link.
 */
export async function onGenerateClick() {
    document.getElementById('generate').disabled = true;
    const accessToken = localStorage.getItem('access_token');
    const rootResponse = await fetch('https://graph.microsoft.com/v1.0/me/drive/special/photos', { 'headers': { 'Authorization': `Bearer ${accessToken}` } });
    if (!rootResponse.ok) {
        alert(await rootResponse.text());
        return;
    }
    const rootDriveItem = await rootResponse.json();
    const geoData = await generateImpl(accessToken, rootDriveItem);
    await dbPut(geoData);
    location.reload(); // to re-render the geo data
}
//# sourceMappingURL=index.js.map