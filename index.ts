/**
 * This single-page html+js app combines your OneDrive photos with an embedded Google Map.
 * Each photo with known latitude and longitude is shown as a "AdvancedMarkerElement" on the google map,
 * and it uses google's MarkerClusterer to group them together if there are too many.
 * If you click on a cluster, then each individual matching thumbnail will be shown below the map.
 * A sidebar includes a date-range filter, and freeform text filter.
 * 
 * For scanning, we expect about 30-40 top-level folders with 20-40 subfolders within each one.
 * It takes OneDrive about about 1s to retrieve a folder's child listing.
 * 
 * TODO: implement all the sidebar
 */

// Google Maps type imports
/// <reference types="google.maps" />
import { setCookie, getCookie, deleteCookie, fetchAsDataUrl } from './utils.js';

// The markerClusterer library is loaded from CDN, as window.marketClusterer.
// The following workaround is to give it strong typing.
import type {
    MarkerClusterer as MarkerClustererType,
    Cluster,
    defaultOnClusterClickHandler as DefaultOnClusterClickHandlerType
} from '@googlemaps/markerclusterer';
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
let ACCESS_TOKEN: string | null = null; // provided by OneDrive redirect as a query-param and stored in cookie
export let PHOTOS_FOLDER_ID: string | null = null; // initialized within onload() if we're logged in

/**
 * GOOGLE MAPS INTEGRATION.
 * We need to keep this list ourselves, since google's Map object doesn't give them to us.
 */
let MARKERS: AdvancedMarkerElement[] = [];

/**
 * Type definition for geolocated photo items that are displayed on the map.
 * These objects are created in walkFolderAsync and consumed by renderGeo.
 */
interface GeoItem {
    position: {
        lat: number;
        lng: number;
    };
    date: string; // ISO date string for JSON serialization compatibility
    thumbnailDataUrl: string;
    webUrl: string;
    aspectRatio: number;
}

/**
 * Sets up authentication and UI by:
 * (1) checking for a OneDrive access token via query-params and cookies,
 * (2) checking whether that access token is still good,
 * (3) updating visibility of various page elements based on whether access token is still good,
 *     and whether a geo.json file already exists.
 * 
 * INVARIANT: at the end of this function,
 * 1. The global string variables ACCESS_TOKEN, PHOTOS_FOLDER_ID either are valid+working, or are both null.
 * 2. The important document element IDs (geo, generate, logout, login) all have their visibility set appropriately.
 */
export async function onBodyLoad(): Promise<void> {
    // 1. Get tokens from URL params or cookies
    const url = new URL(location.href);
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    ACCESS_TOKEN = params.get("access_token");

    if (ACCESS_TOKEN) {
        setCookie('access_token', ACCESS_TOKEN);
        window.history.replaceState(null, '', window.location.pathname);
    } else {
        ACCESS_TOKEN = getCookie('access_token');
    }

    PHOTOS_FOLDER_ID = null;
    if (ACCESS_TOKEN) {
        // 2. Validate ACCESS_TOKEN by attempting to get PHOTOS_FOLDER_ID
        try {
            PHOTOS_FOLDER_ID = (await fetchAsync('GET', `https://graph.microsoft.com/v1.0/me/drive/special/photos`)).id;
        } catch (e) {
            ACCESS_TOKEN = null;
            deleteCookie('access_token');
            if (!(e instanceof Error) || !e.message.startsWith('401')) {
                alert(String(e))
            }
        }
    }

    // 3. Update UI elements based on whether ACCESS_TOKEN is valid, and whether geo.json exists
    document.getElementById('login')!.style.display = ACCESS_TOKEN ? 'none' : 'inline';
    document.getElementById('logout')!.style.display = ACCESS_TOKEN ? 'block' : 'none';
    document.getElementById('generate')!.style.display = ACCESS_TOKEN ? 'inline' : 'none';
    if (ACCESS_TOKEN) {
        try {
            await renderGeo(await fetchAsync('GET', `https://graph.microsoft.com/v1.0/me/drive/items/${PHOTOS_FOLDER_ID}:/geo.json`));
        } catch {
            await renderGeo(null);
        }
    }
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
 * Clears authentication cookies and redirects to Microsoft logout page.
 * After logout, Microsoft will redirect back to this page.
 */
export function onLogoutClick(): void {
    deleteCookie('access_token');
    location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/logout?post_logout_redirect_uri=${location.href}`;
}

/**
 * Given a driveItem response from OneDrive, which is assumed to have ['@microsoft.graph.downloadUrl'], this function
 * 1. updates the "geo" href link for the user to download the geo file
 * 2. using geoItems if this parameter was used, or downloading from driveItem if not, this recreates the google map and populates it with markers.
 * 
 * Or, if given null, this removes the geo information.
 *
 * TODO: I'm worried that downloading the file may be slow. If so, we should cache it to localStorage, using
 * a content-hash (maybe the driveitem's etag?) to verify the cache is still valid.
 * 
 * TODO: I'm also worried that constructing 10,000 items as markers may be slow, or that google map might be slow
 * to cluster/render them. Will have to see.
 */
async function renderGeo(driveItem: object | null, geoItems: GeoItem[] | undefined = undefined): Promise<void> {
    for (const marker of MARKERS) {
        marker.map = null;
        (marker.content as Element)?.remove();
        marker.content = null;
    }
    MARKERS = [];

    if (driveItem === null) {
        document.getElementById('geo')!.style.display = 'none';
        return;
    }

    const url = (driveItem as any)['@microsoft.graph.downloadUrl'] as string | undefined;
    if (!url) throw new Error("Drive item missing @microsoft.graph.downloadUrl");
    (document.getElementById('geo')! as HTMLAnchorElement).href = url;
    document.getElementById('geo')!.style.display = 'block';
    document.getElementById('map')!.style.display = 'block';

    if (!geoItems) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to download geo.json: ${response.statusText}`);
        geoItems = await response.json() as GeoItem[];
    }

    // The google maps library loads asynchronously. Here's how we await until it's finished loading:
    const markerLibrary = await google.maps.importLibrary("marker") as google.maps.MarkerLibrary;
    const map = (document.getElementById("map")! as google.maps.MapElement).innerMap;
    geoItems.length = Math.min(geoItems.length, 1000);


    for (const geoItem of geoItems) {
        try {
            const content = document.createElement('img');
            content.src = geoItem.thumbnailDataUrl;
            content.loading = "lazy";
            content.style.width = "6em";
            content.style.height = `${6.0 / geoItem.aspectRatio}em`;
            const marker = new markerLibrary.AdvancedMarkerElement({ map, content, position: geoItem.position });
            MARKERS.push(marker);
        } catch (e) {
            console.error(String(e));
        }
    };

    new markerClusterer.MarkerClusterer({
        markers: MARKERS, map, onClusterClick: (event: google.maps.MapMouseEvent, cluster: Cluster, map: google.maps.Map): void => {
            // TODO: below the map, show all the thumbnails in the cluster
            // And if the cluster has items in small bounds, then suppress the default handler.
            markerClusterer.defaultOnClusterClickHandler(event, cluster, map);
        }
    });
}

/**
 * This function is called when the user clicks the "Generate" button.
 * It does a recursive walk of the user's OneDrive Photos folder,
 * and uploads the resulting geo.json file, and updates the link.
 */
export async function onGenerateClick(): Promise<void> {
    try {
        (document.getElementById('generate')! as HTMLButtonElement).disabled = true;
        document.getElementById('geo')!.style.display = 'none';

        // Walk the Photos folder and synthesize geo.json out of it
        const size = (await fetchAsync('GET', `https://graph.microsoft.com/v1.0/me/drive/items/${PHOTOS_FOLDER_ID}`)).size;
        const geoItems: GeoItem[] = [];
        await walkFolderAsync(geoItems, [], PHOTOS_FOLDER_ID!, { bytesSoFar: 0, bytesTotal: size, fetchesSoFar: 0, startMs: Date.now() });

        // Save the geo.json
        const uploadResults = await fetchAsync('PUT', `https://graph.microsoft.com/v1.0/me/drive/items/${PHOTOS_FOLDER_ID}:/geo.json:/content`, JSON.stringify(geoItems), 'application/json');
        await renderGeo(uploadResults, geoItems);
        log('Done');
    } catch (e) {
        const errorMessage = e instanceof Error ? `${e.message} - ${e.stack}` : String(e);
        log(`ERROR - ${errorMessage}`);
    }
}

function log(s: string): void {
    document.getElementById('log')!.innerText = s;
    console.log(s);
}

/**
 * Converts seconds to human-readable format (e.g., "1h 23m 45s", "2m 30s", "45s")
 */
function formatDuration(seconds: number): string {
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
    } else {
        return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m${Math.round(seconds % 60)}s`;
    }
}

/** Recursively walks the folder, accumulating info for every geolocated filename it encounters.
 * The return type is 'void' because results are accumulated in the 'acc' parameter.
 * Also, progress is tracked in the 'tracking' parameter.
 * 
 * Side-effect: it displays its progress to the user with the 'log' function.
 */
async function walkFolderAsync(acc: GeoItem[], path: string[], folderId: string, tracking: { fetchesSoFar: number; startMs: number; bytesTotal: number; bytesSoFar: number }): Promise<void> {
    if (acc.length > 200) return;
    if (path[0] === "todo") return;

    const items = (await fetchAsync('GET', `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/children?$top=10000&$expand=thumbnails&select=name,id,size,folder,file,location,photo,video,webUrl`)).value as any[];
    tracking.fetchesSoFar += 1;
    const elapsedSecs = (Date.now() - tracking.startMs) / 1000
    const elapsed = formatDuration(elapsedSecs);
    const remaining = formatDuration(elapsedSecs * (tracking.bytesTotal - tracking.bytesSoFar) / tracking.bytesSoFar);
    log(`Scanned ${acc.length} files in ${elapsed} [${Math.round(tracking.bytesSoFar / tracking.bytesTotal * 100)}%, ${tracking.fetchesSoFar}], ${remaining} remaining. ${path.join(' > ')}`);


    for (const item of items.reverse()) {
        const itemPath = [...path, item.name];
        if (item.folder) {
            await walkFolderAsync(acc, itemPath, item.id, tracking);
        } else if (item.file && item.location && item.thumbnails?.at(0)?.small?.url && item.photo?.takenDateTime) {
            acc.push({
                position: {
                    lat: Math.round(item.location.latitude * 100000) / 100000,
                    lng: Math.round(item.location.longitude * 100000) / 100000,
                },
                date: item.photo.takenDateTime,
                thumbnailDataUrl: await fetchAsDataUrl(item.thumbnails[0].small.url),
                webUrl: item.webUrl,
                aspectRatio: Math.round(item.thumbnails[0].small.width / item.thumbnails[0].small.height * 100) / 100,
            });
        }
        tracking.bytesSoFar += item.size;
    }
}

/**
 * Sends a HTTP request using the fetch API. Retries if throttled, up to a few times.
 * The return is typed as "Any". It will be either a JSON-parse of the response (if response
 * content-type includes "application/json"), or a string otherwise.
 */
export async function fetchAsync(verb: 'GET' | 'PUT' | 'POST', url: string | URL, requestBody: string | undefined = undefined, requestContentType: string | undefined = undefined, authorizationBearer: string | null = ACCESS_TOKEN): Promise<any> {
    for (let i = 0; ; i++) {
        const response = await fetch(url, {
            'method': verb,
            'headers': {
                ...(authorizationBearer && { 'Authorization': `Bearer ${encodeURIComponent(authorizationBearer)}` }),
                ...(requestContentType && { 'Content-Type': requestContentType })
            },
            'body': requestBody || null
        });

        if (!response.ok) {
            if (response.status === 429 && i < 3) { // throttled; retry
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }
            throw new Error(`${response.status} - ${await response.text()}`);
        }
        return (response.headers.get('Content-Type')?.includes('application/json')) ? response.json() : response.text();
    }
}

