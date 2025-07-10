/**
 * Copyright (c) Lucian Wischik
 */
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
import { generateImpl, asClusters, boundsForDateRange, numToDate } from './geoitem.js';
import { Histogram } from './histogram.js';
import { ImgPool, MarkerPool } from './pools.js';
import { Overlay } from './overlay.js';
// The markerClusterer library is loaded from CDN, as window.marketClusterer.
// The following workaround is to give it strong typing.
import { authFetch, dbGet, dbPut, escapeHtml, exchangeCodeForToken, FetchError, myFetch } from './utils.js';
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
let MAP;
let MARKER_POOL;
let IMG_POOL;
let OVERLAY;
let HISTOGRAM;
let TEXT_FILTER;
// The items that histogram/map should work off. This is typically a copy of the local cache,
// set only once during onLoad. But during photo ingestion it gets updated through the
// course of ingestion. It's undefined if there's no local cache and ingestion hasn't start.
let g_geoData;
// This is the filter that's implied by the current filter controls. It gets updated
// in response to user actions, by installHandlers. It gets read by showCurrentGeodata.
let g_filter = { dateRange: undefined, text: undefined };
/**
 * Sets up authentication and UI.
 * - If we have local cache of geoData, we set up map, thumbnails, histogram
 * - If we have a ?code= param from OAuth2 redirect, we redeem it for tokens and proceed.
 * - We attempt to fetch the Photos folder, to learn if the access_token is valid or can
 *   be refreshed, and if the local cache is up to date.
 * - We display instructions based on login and staleness.
 */
export async function onBodyLoad() {
    const params = new URLSearchParams(new URL(location.href).search);
    const code = params.get('code');
    const state = params.get('state');
    if (code || state)
        window.history.replaceState(null, '', window.location.pathname);
    MAP = document.getElementById("map").innerMap;
    MARKER_POOL = new MarkerPool(MAP, await google.maps.importLibrary("marker"));
    IMG_POOL = new ImgPool(document.getElementById('thumbnails-grid'));
    OVERLAY = new Overlay();
    HISTOGRAM = new Histogram(document.getElementById("histogram-container"));
    TEXT_FILTER = document.getElementById('text-filter');
    // Set up map, thumbnails, histogram
    g_geoData = await dbGet();
    if (g_geoData && g_geoData.id === 'sample-data' && localStorage.getItem('access_token'))
        g_geoData = undefined;
    await installHandlers();
    showCurrentGeodata();
    // Process OAuth code if present
    if (code) {
        const code_verifier = sessionStorage.getItem('code_verifier');
        sessionStorage.removeItem('code_verifier');
        const r = await exchangeCodeForToken(CLIENT_ID, code, code_verifier);
        if (r instanceof FetchError) {
            console.error(r.message);
        }
        else {
            localStorage.setItem('access_token', r.accessToken);
            localStorage.setItem('refresh_token', r.refreshToken);
        }
    }
    // Attempt to get Pictures metadata (so validating access token) and validate local cache. Outcomes:
    // - (!accessToken, !geoData, !status) -- user is signed out, no geo data
    // - (!accessToken, geoData, !status) -- user is signed out, geo data from local, we don't know if it's fresh or stale
    // - (accessToken, !geoData, !status) -- user is signed in but no geo data has ever been generated
    // - (accessToken, geoData, fresh|stale) -- user is signed in, geo data from most recent onedrive generation
    let photosDriveItem = null;
    document.getElementById('instructions').innerHTML = '<span class="spinner"></span> checking OneDrive for updates...';
    const r = await authFetch('https://graph.microsoft.com/v1.0/me/drive/special/photos?select=size');
    try {
        if (r.ok)
            photosDriveItem = await r.json();
    }
    catch { }
    const status = photosDriveItem && g_geoData ? (g_geoData.size === photosDriveItem.size ? 'fresh' : 'stale') : undefined;
    instruct(status);
    // Initial action
    const accessToken = localStorage.getItem('access_token');
    if (accessToken && state === 'generate') {
        onGenerateClick();
    }
    else if (!accessToken && !g_geoData) {
        const r = await myFetch('sample.json');
        if (r.ok) {
            g_geoData = await r.json();
            dbPut(g_geoData);
            showCurrentGeodata();
        }
        else {
            console.error(r.text());
        }
    }
}
/**
 * INTERACTION DESIGN PRINCIPLES
 *
 * This model defines the interaction between the map, histogram and text-filter. These are the principles:
 * 1. All three surfaces (map, histogram, filter-text) are places where the user does filtering work.
 *    The user's work on the map is pan/zoom to find an area. The work on the histogram is making/adjusting
 *    a selection (not pan/zoom). The work on the text is typing a search term. They often iterate through
 *    all three forms of work.
 * 2. We must never erase a user's work. However, we deem that when the user releases their mouse button
 *    in the click-drag act of making a histogram selection, then the user has themself erased their map
 *    work of panning/zooming.
 * 3. We will strive to "autosuggest" a user's next iteration of filtering work, a way of offering context or suggestions.
 *    If the user pans/zooms the map, the context/suggestion we make is to pan/zoom the histogram to the smallest
 *    time range that contains all photos in the map viewport. If the user makes a selection on the histogram,
 *    the context/suggestion we make is to pan/zoom the map to contain all the photos in the selection.
 *    However, we don't use the text box as a place to provide context, and we don't offer context/suggestions
 *    in response to the user typing in the text box, since that's not a reliable enough signal.
 * 4. The histogram will always offer full context: if the user zooms out far enough, they'll see every photo in
 *    the database represented in the histogram. It uses color: grey for all photos, but blue if a photo is
 *    within the current map viewport, and yellow if it matches a filter.
 * 5. The map will offer only filtered results: it will only show photos that (1) are within map bounds, (2)
 *    pass the histogram selection filter if any, (3) pass the text filter if any.
 * 6. We prioritize simplicity and predictability. We avoid creating novel non-standard interactions on the
 *    map (like drawing a map selection box). We think that selecting in the histogram is familiar, much like
 *    selecting text in a text editor.
 * 7. We might choose to have have additional context: "Geopic. 65500 photos (5 visible, 100 hidden)". These
 *    numbers are already implied by the histogram when fully zoomed out, but might be useful. We'll place
 *    them for now along with the title at the top left of the page.
 *
 * From these principles we derive that there must be two modes!
 * 1. Map-led exploratory mode. This is defined as whenever the histogram lacks a selection. The user will
 *    be panning and zooming the map. We will autosuggest by panning/zooming the histogram to encompass all
 *    items in the map viewport. Data-flow is one-way `map -> histogram`. Note that if the user pans/zooms
 *    the histogram in this mode, that is considered a temporary inspection rather than work, and will be
 *    lost next time the user pans/zooms the map. When the user makes a selection, we enter filtering mode.
 * 2. Filtering mode. This is defined as whenever the histogram has a selection. The user will be adjusting
 *    the selection and panning/zooming the map. We will autosuggest by automatically panning/zooming the
 *    map to match the selection, dataflow `histogram -> map`, but we can only do this up until the user's
 *    first pan/zoom of the map, after which point we can't automatically move it, dataflow `none`. When the
 *    user deselects their selection, we revert to map-led exploratory mode. We'll introduce one minor nit
 *    here. You might think that  by reverting to map-led exploratory mode then the histogram should
 *    automatically pan/zoom to reflect what's in the viewport. But that's not right, because it wouldn't
 *    be the right opportunity to make an autosuggestion. We'll only make this autosuggestion in response
 *    to the user's first pan/zoom of the map. This will also feel less jarring.
 * 3. Changes to the text filter will not influence either form of autosuggestion. That's because while I
 *    trust that date and geolocation of photos are universal and continuous properties, I think that text
 *    terms are sparse and discontinuous. When a text filter is cleared, all that does is remove yellow
 *    highlights from the histogram and show more photos on the map; it doesn't alter the histogram or map.
 *
 * USER SCENARIOS
 *
 * These scenarios are used to test the robustness of the interaction model. They focus on the user's goal
 * and mental model, not the implementation.
 * - Scenario 1: The "Reminiscing" Query.
 *   - Goal: "We were just talking about our trip to Italy. I want to pull up the photos from that trip to show everyone."
 *   - User Intent: The user thinks of an event as a whole ("Italy trip"). They want to see all photos associated with it,
 *     likely starting with a location they remember.
 * - Scenario 2: The "Specific Moment" Hunt.
 *   - Goal: "I'm looking for that one photo of the sunset over the Grand Canyon. I think we were there in the fall of 2021."
 *   - User Intent: The user has a specific image in mind and uses partial information (a famous place, an approximate time)
 *     to narrow the search.
 * - Scenario 3: The "Rediscovery" Journey.
 *   - Goal: "We stopped at a beautiful little town on our drive through the Alps a few years ago, but I can't remember its name.
 *     I want to trace our route to find it."
 *   - User Intent: The user's memory is spatial and sequential. They want to follow a path and browse visually to jog their memory.
 * - Scenario 4: The "Then and Now" Comparison.
 *   - Goal: "I want to find a photo of our house right after we bought it, and another one from this year to see how the
 *     garden has changed."
 *   - User Intent: The user needs to isolate a single location and then pinpoint two distinct moments in time associated with it.
 */
async function installHandlers() {
    let userHasMapWork = false;
    let boundsChangedByCode = false;
    MAP.addListener('bounds_changed', () => {
        if (!g_geoData)
            return;
        if (!boundsChangedByCode)
            userHasMapWork = Boolean(g_filter.dateRange);
        showCurrentGeodata();
    });
    MAP.addListener('idle', () => boundsChangedByCode = false);
    HISTOGRAM.onSelectionChange = (selection) => {
        if (!g_geoData)
            return;
        g_filter.dateRange = selection;
        if (g_filter.dateRange && !userHasMapWork) {
            const newBounds = boundsForDateRange(g_geoData, g_filter.dateRange);
            if (newBounds) {
                boundsChangedByCode = true;
                MAP.fitBounds(new google.maps.LatLngBounds(newBounds.sw, newBounds.ne));
                return;
            }
        }
        showCurrentGeodata();
    };
    TEXT_FILTER.addEventListener('input', () => {
        if (!g_geoData)
            return;
        const text = TEXT_FILTER.value.trim().toLowerCase();
        g_filter.text = text ? text : undefined;
        TEXT_FILTER.classList.toggle('filter-glow', Boolean(text));
        showCurrentGeodata();
    });
    TEXT_FILTER.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && TEXT_FILTER.value) {
            TEXT_FILTER.value = '';
            TEXT_FILTER.dispatchEvent(new Event('input'));
        }
    });
    OVERLAY.siblingGetter = (id, direction) => {
        const items = Array.from(document.getElementById('thumbnails-grid').children)
            .map(img => img instanceof HTMLImageElement ? img.getAttribute('data-id') : null)
            .filter(id => id !== null);
        const index = items.indexOf(id);
        if (index === -1)
            return undefined;
        else if (direction === 'prev')
            return index <= 0 ? undefined : items[index - 1];
        else
            return index >= items.length - 1 ? undefined : items[index + 1];
    };
    TEXT_FILTER.placeholder = 'Filter, e.g. Person or 2024/03';
    MAP.addListener('rightclick', () => {
        const currentZoom = MAP.getZoom() || 1;
        MAP.setZoom(Math.max(1, currentZoom - 3));
    });
}
function instruct(mode) {
    let instructions;
    const title = '<h1><a href="https://github.com/ljw1004/geopic/blob/main/README.md">Geopic</a></h1> ';
    const sample = g_geoData && g_geoData.id === 'sample-data' ? '<br/><b>Showing sample data for now.</b>' : '';
    if (mode === 'generating') {
        instructions = `${title} Ingesting photos <span class="spinner"></span><br/>`
            + `A full index takes ~30mins for 50,000 photos on a good network; incremental updates will finish in ~30 seconds. `
            + `You can reload this page and it will pick up where it left off. `
            + `<pre id="progress">[...preparing bulk indexer...]</pre>`;
    }
    else if (mode === 'fresh') {
        instructions = `${title} ${g_geoData?.geoItems.length} photos <span title="logout" id="logout">\u23CF</span>`;
    }
    else if (mode === 'stale') {
        instructions = `${title} <span id="generate">Ingest all new photos...</span> <span title="logout" id="logout">\u23CF</span>${sample}`;
    }
    else if (localStorage.getItem('access_token')) {
        instructions = `${title} <span id="generate">Index your photo collection...</span> <span title="logout" id="logout">\u23CF</span>${sample}`;
    }
    else {
        instructions = `${title} <span id="login">Login to OneDrive to index your photos...</span>${sample}`;
    }
    // instructions += '<br/><span id="clear">Clear cache...</span>';
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
 * Handles the login button click event with OAuth2 PKCE code-flow:
 * - sets up code_challenge and code_verifier
 * - stores the latter in sessionStorage where the response to index.html?code=... will find it (so as to redeem the code)
 * - redirects to the Microsoft login page, with a redirect back to index.html?code=...
 */
export async function onLoginClick() {
    const base64url = (array) => btoa(String.fromCharCode.apply(null, Array.from(array))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const code_verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const code_challenge = base64url(new Uint8Array((await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code_verifier)))));
    sessionStorage.setItem('code_verifier', code_verifier);
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: window.location.origin + window.location.pathname,
        scope: 'files.readwrite offline_access',
        code_challenge,
        code_challenge_method: 'S256',
        state: 'generate'
    });
    location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
}
/**
 * Handles the logout button click event.
 */
export async function onLogoutClick() {
    await dbPut(null);
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    location.href = `https://login.microsoftonline.com/common/oauth2/v2.0/logout?post_logout_redirect_uri=${location.href}`;
}
/**
 * Called whenever histogram/thumbnails/markers need to be updated, during onBodyLoad() or in response
 * to user actions from installHandlers(). It applies g_filter to g_geoData, figures out what geoItems
 * should be shown on the three surfaces, and shows them!
 */
function showCurrentGeodata() {
    TEXT_FILTER.style.display = g_geoData ? 'inline-block' : 'none';
    if (!g_geoData)
        return;
    const bounds = MAP.getBounds();
    if (!bounds)
        return;
    const sw = (MAP.getZoom() || 0) <= 2 ? { lat: -90, lng: -179.9999 } : { lat: bounds.getSouthWest().lat(), lng: bounds.getSouthWest().lng() };
    const ne = (MAP.getZoom() || 0) <= 2 ? { lat: 90, lng: 179.9999 } : { lat: bounds.getNorthEast().lat(), lng: bounds.getNorthEast().lng() };
    const [clusters, tally] = asClusters(sw, ne, MAP.getDiv().offsetWidth, g_geoData, g_filter);
    const somePassFilterCount = clusters.reduce((sum, c) => sum + c.somePassFilterItems.length, 0);
    const totalPassFilterCount = clusters.reduce((sum, c) => sum + c.totalPassFilterItems, 0);
    function showItem(item) {
        if (g_geoData?.id === 'sample-data')
            OVERLAY.showDataUrl(item.id, item.thumbnailUrl, `<h1>HIGH QUALITY ONLY FOR YOUR ONEDRIVE PHOTOS</h1> ${escapeHtml(item.name)}`);
        else
            OVERLAY.showId(item.id);
    }
    clusters.sort((a, b) => b.totalPassFilterItems - a.totalPassFilterItems);
    for (const cluster of clusters) {
        const item = cluster.somePassFilterItems.length > 0 ? cluster.somePassFilterItems[0] : cluster.oneFailFilterItem;
        const imgClassName = cluster.totalPassFilterItems === 0 ? 'filtered-out' : g_filter.text ? 'filter-glow' : '';
        const spanText = cluster.totalPassFilterItems <= 1 ? undefined : cluster.totalPassFilterItems.toString();
        const isUsefulToZoom = (MAP.getZoom() || 100) < 17 || clusters.length > 10
            || totalPassFilterCount - cluster.totalPassFilterItems > 10 || cluster.totalPassFilterItems > 10;
        const onClick = () => {
            if (cluster.totalPassFilterItems === 1)
                showItem(item);
            else if (isUsefulToZoom)
                MAP.fitBounds(new google.maps.LatLngBounds(cluster.bounds.sw, cluster.bounds.ne));
            else
                MAP.setCenter(cluster.center);
        };
        const marker = MARKER_POOL.add(item.id, item.thumbnailUrl, imgClassName, spanText, onClick);
        marker.position = item.position;
        marker.zIndex = cluster.totalPassFilterItems;
    }
    MARKER_POOL.finishAdding();
    const MAX_THUMBNAILS = 400;
    const fraction = somePassFilterCount > MAX_THUMBNAILS ? MAX_THUMBNAILS / somePassFilterCount : 1;
    const thumbnails = clusters.flatMap(cluster => cluster.somePassFilterItems.slice(0, Math.ceil(cluster.somePassFilterItems.length * fraction))).sort((a, b) => a.date - b.date);
    for (const item of thumbnails) {
        const img = IMG_POOL.add(item.id, item.thumbnailUrl);
        img.title = `${numToDate(item.date).toLocaleDateString()} - ${escapeHtml(item.name)}`;
        img.setAttribute('data-id', item.id);
        img.onclick = () => showItem(item);
    }
    IMG_POOL.finishAdding();
    HISTOGRAM.setData(tally);
}
/**
 * This function is called when the user clicks the "Generate" button.
 * It does a recursive walk of the user's OneDrive Photos folder,
 * and uploads the resulting geo.json file, and updates the link.
 */
export async function onGenerateClick() {
    instruct('generating');
    const r = await authFetch('https://graph.microsoft.com/v1.0/me/drive/special/photos');
    if (!r.ok) {
        instruct(undefined);
        const reason = await r.text();
        OVERLAY.showError('Error! Try logging out \u23CF then trying again', reason);
        return;
    }
    g_geoData = {
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
            document.getElementById('progress').textContent = [`${g_geoData.geoItems.length} photos so far`, ...update].join('\n');
        }
        else {
            g_geoData.geoItems.push(...update);
            showCurrentGeodata();
        }
    }
    const photosDriveItem = await r.json();
    try {
        g_geoData = await generateImpl(progress, photosDriveItem);
        await dbPut(g_geoData);
        showCurrentGeodata();
        instruct('fresh');
    }
    catch (e) {
        instruct(undefined);
        let details = String(e);
        if (e instanceof Error) {
            const lines = e.stack?.split('\n') || [];
            if (lines.length > 0 && lines[0].includes(e.message))
                lines.shift();
            const stack = lines.length > 0 ? ` -  - ` + lines.join(' - ') : '';
            details = `${e.message}${stack}`;
        }
        OVERLAY.showError('Error! Try refreshing the page and trying again', details);
        return;
    }
}
//# sourceMappingURL=index.js.map