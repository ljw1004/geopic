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
import { generateImpl, GeoData } from './geoitem.js';

// The markerClusterer library is loaded from CDN, as window.marketClusterer.
// The following workaround is to give it strong typing.
import type {
    MarkerClusterer as MarkerClustererType,
    Cluster,
    defaultOnClusterClickHandler as DefaultOnClusterClickHandlerType
} from '@googlemaps/markerclusterer';
import { dbGet, dbPut } from './utils.js';
const markerClusterer = (window as any).markerClusterer as {
    MarkerClusterer: typeof MarkerClustererType;
    defaultOnClusterClickHandler: typeof DefaultOnClusterClickHandlerType;
}

// The AdvancedMarkerElement class is loaded differently.
// Here we're solely using a dev-time type alias.
type AdvancedMarkerElement = google.maps.marker.AdvancedMarkerElement;

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
let MARKERS: AdvancedMarkerElement[] = [];



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
    // 1. Get access_token from query-params or localStorage
    const url = new URL(location.href);
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    let accessToken = params.get("access_token");
    if (accessToken) {
        localStorage.setItem('access_token', accessToken);
    } else {
        accessToken = localStorage.getItem('access_token');
    }

    // 2. Attempt to get geoData, and validate access token. Outcomes:
    // - (!accessToken, !geoData, !status) -- user is signed out, no geo data
    // - (!accessToken, geoData, !status) -- user is signed out, geo data from local, we don't know if it's fresh or stale
    // - (accessToken, !geoData, !status) -- user is signed in but no geo data has ever been generated
    // - (accessToken, geoData, fresh|stale) -- user is signed in, geo data from most recent onedrive generation
    let geoData: GeoData | null = null;
    let status: 'fresh' | 'stale' | undefined;
    const [localCache, driveItem] = await Promise.all([
        dbGet<GeoData>(),
        accessToken ? fetch('https://graph.microsoft.com/v1.0/me/drive/special/photos', { 'headers': { 'Authorization': `Bearer ${accessToken}` } }).then(async r => r.ok ? await r.json() as GeoData : undefined) : Promise.resolve(undefined)
    ]);

    if (!driveItem) {
        localStorage.removeItem('access_token');
        accessToken = null;
        geoData = localCache || null;
        status = undefined;
    } else if (localCache && localCache.size === driveItem.size) {
        geoData = localCache;
        status = 'fresh';
    } else {
        const onedriveCache = await fetch(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/index.json:/content`, { 'headers': { 'Authorization': `Bearer ${accessToken}` } }).then(async r => r.ok ? await r.json() as GeoData : null);
        if (onedriveCache) {
            await dbPut(onedriveCache);
            geoData = onedriveCache;
        } else {
            geoData = localCache || null;
        }
        status = geoData ? (geoData.size === driveItem.size ? 'fresh' : 'stale') : undefined;
    }

    // 3. Update UI elements based on authentication state
    document.getElementById('login')!.style.display = accessToken ? 'none' : 'inline';
    document.getElementById('logout')!.style.display = accessToken ? 'inline' : 'none';
    document.getElementById('generate')!.style.display = accessToken ? 'inline' : 'none';
    console.log(`accessToken: ${accessToken ? 'valid' : 'invalid'}`);
    console.log(`geoData: ${geoData ? 'exists' : 'does not exist'}`);
    console.log(`status: ${status ? status : 'unknown'}`);
    // if (geoData) await renderGeo(geoData);
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

/**
 * Given a driveItem response from OneDrive, which is assumed to have ['@microsoft.graph.downloadUrl'], this function
 * 1. updates the "geo" href link for the user to download the geo file
 * 2. using geoItems if this parameter was used, or downloading from driveItem if not, this recreates the google map and populates it with markers.
 */
export async function renderGeo(geoData: GeoData): Promise<void> {
    MARKERS = [];

    // The google maps library loads asynchronously. Here's how we await until it's finished loading:
    const markerLibrary = await google.maps.importLibrary("marker") as google.maps.MarkerLibrary;
    const map = (document.getElementById("map")! as google.maps.MapElement).innerMap;

    console.log(`Markering...`);
    for (const geoItem of geoData.geoItems.slice(0, 10000)) {
        try {
            const content = document.createElement('img');
            content.src = geoItem.thumbnailUrl;
            content.loading = "lazy";
            content.style.width = "6em";
            content.style.height = `${6.0 / geoItem.aspectRatio}em`;
            const marker = new markerLibrary.AdvancedMarkerElement({ map, content, position: geoItem.position });
            MARKERS.push(marker);
        } catch (e) {
            console.error(String(e));
        }
    };
    console.log('Markered! Clustering...');

    new markerClusterer.MarkerClusterer({
        markers: MARKERS, map, onClusterClick: (event: google.maps.MapMouseEvent, cluster: Cluster, map: google.maps.Map): void => {
            // TODO: below the map, show all the thumbnails in the cluster
            // And if the cluster has items in small bounds, then suppress the default handler.
            markerClusterer.defaultOnClusterClickHandler(event, cluster, map);
        }
    });
    console.log('Clustered!');
}

/**
 * This function is called when the user clicks the "Generate" button.
 * It does a recursive walk of the user's OneDrive Photos folder,
 * and uploads the resulting geo.json file, and updates the link.
 */
export async function onGenerateClick(): Promise<void> {
    (document.getElementById('generate')! as HTMLButtonElement).disabled = true;
    const accessToken = localStorage.getItem('access_token')!;
    const rootResponse = await fetch('https://graph.microsoft.com/v1.0/me/drive/special/photos', { 'headers': { 'Authorization': `Bearer ${accessToken}` } });
    if (!rootResponse.ok) { alert(await rootResponse.text()); return; }
    const rootDriveItem = await rootResponse.json();
    const geoData = await generateImpl(accessToken, rootDriveItem);
    await dbPut(geoData);
    location.reload(); // to re-render the geo data
}
