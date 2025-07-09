import { FetchError, authFetch, blobToDataUrl, multipartUpload, postprocessBatchResponse, progressBar, rateLimitedBlobFetch } from './utils.js';

const SCHEMA_VERSION = 5;

/**
 * Numdate is a compact way of storing dates, in integer numbers, YYYYMMDD format.
 */
export type Numdate = number;

/**
 * A position. lng might be negative. Beware of the antimeridian (where -180 and +180 meet)...
 */
export interface Position {
    lat: number;
    lng: number;
}

/**
 * This object contains everything we we need for a folder to (1) cache and validate cache, (2) display thumbnails on a map.
 * This object will be serialized to JSON and stored on OneDrive.
 */
export interface GeoData {
    schemaVersion: number; // version number
    id: string; // OneDrive ID of this folder
    size: number; // for cache validation
    lastModifiedDateTime: string; // for cache validation
    cTag: string; // for cache validation
    eTag: string; // for cache validation
    immediateChildCount: number; // the immediate children are the first items in geoItems

    folders: string[]; // Lowercase. Within a WorkItem, folders[0] is always that workitem's folder
    geoItems: GeoItem[];
}

/**
 * An individual photo/video with geolocation data.
 */
export interface GeoItem {
    id: string; // OneDrive ID
    position: Position; // longitude and latitude
    date: Numdate; // in format "YYYYMMDD" e.g. 20241231 for 31st December 2024
    thumbnailUrl: string; // typically a data: url
    name: string; // filename, lowercase
    folderIndex: number; // an index into GeoData.folders[] array
    tags: string[]; // lowercase
}

/**
 * Input to asClusters() -- a filter on which GeoItems to include in the clusters
 */
export interface Filter {
    dateRange: { start: Numdate, end: Numdate } | undefined; // in the same "YYYYMMDD" format as GeoItem.date. End is exclusive.
    text: string | undefined; // Lowercase
}

/**
 * Output from asClusters() -- a cluster of GeoItems to be displayed on the map
 */
export interface Cluster {
    oneFailFilterItem: GeoItem | undefined;  // up to one item that fails the filter
    somePassFilterItems: GeoItem[];  // a selection of items that pass the filter
    totalPassFilterItems: number;  // how many items passed the filter
    bounds: { sw: Position, ne: Position };
    center: Position;
}

/**
 * Output from asClusters() -- a tally of every single GeoItem, broken down by date and how many items
 * there were on each date, broken down by how many were in map bounds, and how many satisfied the text filter if any.
 */
export type Tally = {
    dateCounts: Map<Numdate, OneDayTally>;
};

/**
 * Tallies for a single day. If no filter is being used, then we store counts in 'outFilter'.
 */
export type OneDayTally = { [bounds in 'inBounds' | 'outBounds']: { [filter in 'inFilter' | 'outFilter']: number } };


/**
 * For creating an index of GeoItems and CacheData, we use "Workitems":
 * - A queue "ready" of workitems that need to be processed by the workitem-processor
 * - A queue "toFetch" of workitems that need the batch-processor to fetch their requests
 * - A dictionary "waiting" from path to workitems whose cache still needs geoItems from more subfolders
 * 
 * The overall cycle is:
 * 1. Place root "pictures" folder into toFetch queue, with requests for its cache and children
 * 2. [Processor] Process all items in "ready". If we processed an "END" item for the root folder, we're done.
 * 3. [Batcher] Remove as many items from "toFetch" as we can (up to max 20 requests), fetch responses, and push items into "ready"
 * 4. Repeat from step 2.
 * 
 * The cycle for an individual workitem (and the work done by the processor) is this:
 * 1. It was placed in "toFetch" with state=START and requests for its cache and children
 * 2. The batcher resolved those requests and placed it in "ready" with responses
 * 3. The processor takes a START item with responses (and no requests) and does this:
 *    1. If cache agrees with metadata, pushes self in state END into "ready" and is done. Otherwise...
 *    2. For all immediate children, concurrently fetches their thumbnails and places them in cache.geoItems
 *    3. If there are no subfolders, push self in state END into "toFetch" with a request to upload cache, and we're done. Otherwise...
 *    4. Place self in "waiting" with state=END, keyed by self's path, with remainingSubfolders set to the number of subfolders
 * 4. If we'd placed self in END with a request to upload cache, the batcher does so, and places self in "ready" with response.
 * 5. The processor takes an END item with no requests and does this:
 *    1. Figure out the path to the parent. If there is none, we're finished the overall cycle!
 *    2. Look up the parent in "waiting". It will necessarily be there.
 *    3. Append self's cache.geoItems to the parent's cache.geoItems, and decrement the parent's remainingSubfolders count.
 *    4. If parent has no remaining subfolders, remove from "waiting", and push into "toFetch" with a request to upload it's cache.
 */
interface WorkItem {
    state: 'START' | 'END';
    requests: any[]; // requests needed before we can proceed; added by whoever created the workitem, removed by batch-API
    responses: { [id: string]: any }; // reponses; added by batch-API, removed by the workitem processor
    data: GeoData; // initialized upon creation with an empty list of geoItems; processor will append to the list
    path: string[]; // Empty for root
    remainingSubfolders: number; // if cache/geoItems is incomplete, this is how many subfolders it still needs
};

function cacheFilename(path: string[]): string {
    if (path.length === 0) return 'index.json';
    return path.join('_') + '.json';
}


/**
 * Creates a START WorkItem with two requests, one for children and one for cache.
 */
function createStartWorkItem(driveItem: any, path: string[]): WorkItem {
    return {
        state: 'START',
        requests: [
            {
                id: `children-${driveItem.id}`,
                method: 'GET',
                url: `/me/drive/items/${driveItem.id}/children?$top=10000&expand=tags,thumbnails&select=name,id,ctag,etag,size,lastModifiedDateTime,folder,file,location,photo,video`
            },
            {
                id: `cache-${driveItem.id}`,
                method: 'GET',
                url: `/me/drive/special/approot:/${cacheFilename(path)}:/content`
            }
        ],
        responses: {},
        data: {
            schemaVersion: SCHEMA_VERSION,
            id: driveItem.id,
            size: driveItem.size,
            lastModifiedDateTime: driveItem.lastModifiedDateTime,
            cTag: driveItem.cTag,
            eTag: driveItem.eTag,
            immediateChildCount: 0,
            folders: [],
            geoItems: [],
        },
        path,
        remainingSubfolders: 0
    };
}

/**
 * Creates an END workitem with one request, to upload to cache
 */
function createEndWorkItem(item: WorkItem): WorkItem {
    return {
        ...item, state: 'END', responses: {}, requests: [
            {
                id: `write-${item.data.id}`,
                method: 'PUT',
                url: `/me/drive/special/approot:/${cacheFilename(item.path)}:/content`,
                // I experimentally found weird bugs and workarounds in the batch API (not the individual API):
                // - If I upload an object with content-type application/json, OneDrive claims success but stores a file of size 0
                // - If I upload a string, or base64-encoded json string, with application/json, OneDrive fails with "Invalid json body"
                // - If I upload a base64-encoded json string as text/plain, OneDrive succeeds and stores the file, and subsequent download has content-type application/json
                body: btoa((Array.from(new TextEncoder().encode(JSON.stringify(item.data)), b => String.fromCharCode(b))).join('')),
                headers: { 'Content-Type': 'text/plain' }
            }

        ]
    }
}


/**
 * Creates a GeoItem
 */
function createGeoItem(driveItem: any, folderIndex: number): GeoItem {
    const d = new Date(driveItem.photo.takenDateTime); // ISO8601 string "2019-08-05T17:42:22Z"
    const date = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); // YYYYMMDD number

    return {
        id: driveItem.id,
        name: driveItem.name.toLowerCase(),
        position: {
            lat: Math.round(driveItem.location.latitude * 100000) / 100000,
            lng: Math.round(driveItem.location.longitude * 100000) / 100000,
        },
        date,
        thumbnailUrl: driveItem.thumbnails[0].small.url,
        folderIndex,
        tags: (driveItem.tags || []).map((t: any) => t.name.toLowerCase()),
    };
}

/**
 * Resolves all thumbnails that haven't yet been resolved.
 */
async function resolveThumbnails(f: (s: string) => void, item: WorkItem): Promise<void> {
    let lastPct = "";
    function log(count: number, total: number, throttled: boolean): void {
        const pct = `${Math.floor(count / total * 100)}%`;
        if (pct === lastPct) return;
        lastPct = pct;
        f(`making thumbnails ${pct}${throttled ? ' (throttled)' : ''}`);
    }

    const fetches = await rateLimitedBlobFetch(log, item.data.geoItems.filter(geo => !geo.thumbnailUrl.startsWith('data:')).map(gi => [gi.thumbnailUrl, gi]));
    for (const [blobOrError, geoItem] of fetches) {
        if (blobOrError instanceof Blob) {
            geoItem.thumbnailUrl = await blobToDataUrl(blobOrError);
        } else {
            console.error(`Failed to fetch thumbnail ${geoItem.thumbnailUrl}: ${blobOrError.message}`);
        }
    }
    if (fetches.length > 0 && lastPct !== '100%') log(100, 100, false); // so it appears as "100%"
}


/**
 * Recursive walk of all photos in the Pictures folder, reading and writing a persistent cache in OneDrive.
 * Takes ~20mins for 10 years' worth of photos.
 * 
 * TODO: when cache is invalid but exists, any cached geoItems (with thumbnails) are still valid and should be used.
 */
export async function generateImpl(progress: (p: string[] | GeoItem[]) => void, photosDriveItem: any): Promise<GeoData> {
    const waiting = new Map<string, WorkItem>();
    const toProcess: WorkItem[] = [];
    const toFetch: WorkItem[] = [createStartWorkItem(photosDriveItem, [])];
    const stats = { bytesFromCache: 0, bytesProcessed: 0, bytesTotal: photosDriveItem.size, startTime: Date.now() };

    function log(item: WorkItem): (s?: string) => void {
        return (s) => {
            const bar = progressBar(stats.bytesFromCache, stats.bytesProcessed, stats.bytesTotal);
            const folder = item.path.length === 0 ? ['Pictures'] : item.path;
            progress([`[${bar}]`, folder.join('/'), s || ' ']);
        }
    }

    while (true) {
        const item = toProcess.shift();
        if (item && item.state === 'START') {
            const cacheResult = item.responses[`cache-${item.data.id}`];
            const childrenResult = item.responses[`children-${item.data.id}`];
            if (childrenResult.body.error && childrenResult.body.error.code === 'activityLimitReached') {
                await new Promise(resolve => setTimeout(resolve, 2000));
                toProcess.unshift(item);
                continue;
            }
            if (cacheResult.status === 200 && cacheResult.body.size === item.data.size && cacheResult.body.schemaVersion === SCHEMA_VERSION) {
                stats.bytesFromCache += item.data.size;
                toProcess.unshift({ ...item, data: cacheResult.body, state: 'END', requests: [], responses: {} });
                progress(cacheResult.body.geoItems);
                continue;
            }
            const cache: Map<string, string> = new Map(); // if not the whole cache, we'll at least re-use thumbnails
            if (cacheResult.status === 200) {
                const cacheGeoData = cacheResult.body as GeoData;
                for (const cachedItem of cacheGeoData.geoItems.splice(0, cacheGeoData.immediateChildCount)) {
                    cache.set(cachedItem.id, cachedItem.thumbnailUrl);
                }
            }

            // Kick off subfolders, and gather immediate children (but resolving their thumbnails is deferred until our finish-action)
            for (const child of childrenResult.body.value) {
                if (child.folder) {
                    toFetch.push(createStartWorkItem(child, [...item.path, child.name]));
                    item.remainingSubfolders++;
                } else if (child.file) {
                    stats.bytesProcessed += child.size;
                    if (child.location && child.location.latitude && child.location.longitude && child.thumbnails?.at(0)?.small?.url && child.photo?.takenDateTime) {
                        const folderIndex = 0; // invariant: item.folders[0] will be folder of that workitem
                        const childItem = createGeoItem(child, folderIndex);
                        if (cache.has(childItem.id)) childItem.thumbnailUrl = cache.get(childItem.id)!;
                        item.data.geoItems.push(childItem);
                    }
                }
            }
            item.data.immediateChildCount = item.data.geoItems.length;
            if (item.data.immediateChildCount > 0) item.data.folders.push(item.path.join('/').toLowerCase());

            // Book-keeping: either our finish-action can be done now, or is done by our final subfolder.
            if (item.remainingSubfolders === 0) {
                await resolveThumbnails(log(item), item);
                progress(item.data.geoItems);
                toFetch.unshift(createEndWorkItem(item));
            } else {
                toFetch.sort((a, b) => cacheFilename(a.path).localeCompare(cacheFilename(b.path))); // alphabetical order to finish off subtrees quicker
                waiting.set(cacheFilename(item.path), item);
            }
        } else if (item && item.state === 'END') {
            log(item)();
            if (item.path.length === 0) return item.data; // Finished the root folder!

            // Book-keeping: if our parent's finish-action was left to us, then we'll do it now.
            // We'll have to adjust all our folder indexes. Invariant: a child's folders[] are
            // are all different from those of its parent (hence no need to dedupe).
            const parentName = cacheFilename(item.path.slice(0, -1));
            const parent = waiting.get(parentName)!;
            try {
                const adjustedItems = item.data.geoItems.map(gi => ({ ...gi, folderIndex: gi.folderIndex + parent.data.folders.length }));
                parent.data.geoItems = parent.data.geoItems.concat(adjustedItems);
                parent.data.folders = parent.data.folders.concat(item.data.folders);
            } catch (e) {
                console.error(String(e));
                debugger;
            }
            parent.remainingSubfolders--;
            if (parent.remainingSubfolders === 0) {
                await resolveThumbnails(log(parent), parent);
                progress(parent.data.geoItems.slice(0, parent.data.immediateChildCount));
                waiting.delete(parentName);
                const data = JSON.stringify(parent.data);
                if (data.length < 4 * 1024 * 1024) {
                    toFetch.unshift(createEndWorkItem(parent));
                } else {
                    const logpct = (count: number, total: number) => log(parent)(`upload ${Math.floor(count / total * 100)}%`);
                    await multipartUpload(logpct, cacheFilename(parent.path), data);
                    toProcess.unshift({ ...parent, state: 'END', responses: {}, requests: [] });
                }
            }
        } else {
            const thisFetch: WorkItem[] = [];
            const requests: any[] = [];
            while (toFetch.length > 0 && requests.length < 18) {
                const item = toFetch.shift()!;
                requests.push(...item.requests);
                thisFetch.push(item);
            }
            let batchResponse: any = null;
            while (true) {
                const body = JSON.stringify({ requests });
                batchResponse = await authFetch('https://graph.microsoft.com/v1.0/$batch', {
                    'method': 'POST',
                    'headers': {
                        'Content-Type': 'application/json',
                    },
                    'body': body
                });
                if (batchResponse.status !== 429) break;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            if (!batchResponse.ok) throw new FetchError(batchResponse, await batchResponse.text());
            const batchResult = await batchResponse.json();
            await postprocessBatchResponse(batchResult);
            for (const r of await batchResult.responses) {
                const item = thisFetch.find(item => item.requests.some(req => req.id === r.id))!;
                item.responses[r.id] = r;
            }
            thisFetch.forEach(item => item.requests = []);
            toProcess.push(...thisFetch);
        }
    }
}

/**
 * Given a longitude, normalizes it to the range [-180, 180).
 * Used for instance if you want to calculate "lng1 + width" which might cross the antimeridian.
 */
function lngWrap(lng: number): number {
    return (lng + 180 + 360) % 360 - 180;
}

/**
 * Returns the westmost of two longitudes -- the one that can be reached
 * from the other by travelling less than 180 degrees westwards.
 * If the two points are exactly opposite, the choice is arbitrary.
 */
function westmost(lng1: number, lng2: number): number {
    // use +720 instead of +360 to allow for mild non-normalization of input values (so we still get positive distance)
    return (lng1 - lng2 + 720) % 360 < 180 ? lng2 : lng1;
}

/**
 * Returns the eastmost of two longitudes -- the one that can be reached
 * from the other by travelling less than 180 degrees eastwards.
 * If the two points are exactly opposite, the choice is arbitrary.
 */
function eastmost(lng1: number, lng2: number): number {
    // use +720 instead of +360 to allow for mild non-normalization of input values
    return (lng1 - lng2 + 720) % 360 < 180 ? lng1 : lng2;
}

/**
 * This function takes a map viewport, represented by (1) its lat/lng bounds, (2) its pixel dimensions.
 * It splits this into "clusters" (tiles), each cluster being an approximately 60x60 square of pixels (give or take;
 * if the pixelWidth/Height don't neatly divide into 60 then we'll use however many clusters best fit).
 * It iterates through all the items (it's fast! at about 50k points in one ms) and figures out which cluster each item
 * belongs to.
 * 
 * It returns an array of clusters that contain at least one item. Each returned cluster is represented by
 * (1) a list of up to 20 items in that cluster, (2) the total count of items in that cluster.
 * The tiling is "stable": when the user pans the map, cluster boundaries remain fixed.
 */
export function asClusters(sw: Position, ne: Position, pixelWidth: number, geoData: GeoData, filter: Filter): [Cluster[], Tally] {
    const TILE_SIZE_PX = 60;
    const MAX_ITEMS_PER_TILE = 40;
    const tileSize = ((ne.lng - sw.lng + 360) % 360 || 360) / Math.max(1, Math.round(pixelWidth / TILE_SIZE_PX));
    const swSnap = { lat: Math.floor(sw.lat / tileSize) * tileSize, lng: lngWrap((Math.floor(sw.lng / tileSize) * tileSize)) };
    const numTilesX = Math.ceil(((ne.lng - swSnap.lng + 360) % 360) / tileSize);
    const numTilesY = Math.ceil((ne.lat - swSnap.lat) / tileSize);
    const tiles: Cluster[] = [];
    for (let y = 0; y < numTilesY; y++) {
        for (let x = 0; x < numTilesX; x++) {
            tiles.push({
                somePassFilterItems: [],
                totalPassFilterItems: 0,
                oneFailFilterItem: undefined,
                bounds: {
                    sw: { lat: swSnap.lat + y * tileSize, lng: lngWrap(swSnap.lng + x * tileSize) },
                    ne: { lat: swSnap.lat + (y + 1) * tileSize, lng: lngWrap(swSnap.lng + (x + 1) * tileSize) }
                },
                center: { lat: swSnap.lat + (y + 0.5) * tileSize, lng: lngWrap(swSnap.lng + (x + 0.5) * tileSize) }
            });
        }
    }

    const filterText = filter.text ? filter.text.toLowerCase() : undefined;
    const filterFolders =
        filterText === undefined ? new Set<number>() :
            new Set(geoData.folders.map((f, i) => f.includes(filterText) ? i : -1).filter(i => i !== -1))

    const dateCounts: Map<Numdate, OneDayTally> = new Map();

    // CARE! Following loop is hot; goal is 50,000 items in 5ms, but we're currently at 10ms
    for (const item of geoData.geoItems) {
        let tally = dateCounts.get(item.date); // PERF: this lookup costs 2ms
        if (!tally) {
            tally = { inBounds: { inFilter: 0, outFilter: 0 }, outBounds: { inFilter: 0, outFilter: 0 } };
            dateCounts.set(item.date, tally);
        }
        const x = Math.floor(((item.position.lng - swSnap.lng + 360) % 360) / tileSize);
        const y = Math.floor((item.position.lat - swSnap.lat) / tileSize);
        const inBounds = (x >= 0 && x < numTilesX && y >= 0 && y < numTilesY);
        const inFilter = filterText !== undefined && (item.name.includes(filterText) || filterFolders.has(item.folderIndex) || item.tags.some(tag => tag.includes(filterText)));
        const inDateRange = filter.dateRange === undefined || (item.date >= filter.dateRange.start && item.date < filter.dateRange.end);
        tally[inBounds ? 'inBounds' : 'outBounds'][inFilter ? 'inFilter' : 'outFilter']++;
        if (!inBounds) continue;
        const tile = tiles[y * numTilesX + x];
        if ((filter.text && !inFilter) || !inDateRange) {
            if (tile.oneFailFilterItem === undefined) tile.oneFailFilterItem = item;
            continue;
        }
        if (tile.somePassFilterItems.length < MAX_ITEMS_PER_TILE) tile.somePassFilterItems.push(item); // PERF: this push costs 1ms
        tile.totalPassFilterItems++;
    }
    return [tiles.filter(t => t.somePassFilterItems.length > 0 || t.oneFailFilterItem !== undefined), { dateCounts }];
}

export function boundsForDateRange(geoData: GeoData, dateRange: { start: Numdate, end: Numdate }): { sw: Position, ne: Position } | undefined {
    let r: { sw: Position, ne: Position } | undefined = undefined;
    for (const item of geoData.geoItems) {
        const inDateRange = dateRange === undefined || (item.date >= dateRange.start && item.date < dateRange.end);
        if (!inDateRange) continue;
        if (r === undefined) {
            r = { sw: structuredClone(item.position), ne: structuredClone(item.position) };
        } else {
            r.sw.lat = Math.min(r.sw.lat, item.position.lat);
            r.sw.lng = westmost(r.sw.lng, item.position.lng);
            r.ne.lat = Math.max(r.ne.lat, item.position.lat);
            r.ne.lng = eastmost(r.ne.lng, item.position.lng);
        }
    }
    return r;
}