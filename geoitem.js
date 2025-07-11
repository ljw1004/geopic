/**
 * Copyright (c) Lucian Wischik
 */
import { FetchError, authFetch, blobToDataUrl, multipartUpload, postprocessBatchResponse, progressBar, rateLimitedBlobFetch } from './utils.js';
const SCHEMA_VERSION = 5;
/**
 * Converts a number in YYYYMMDD format to a Date object.
 */
export function numToDate(yyyymmdd) {
    const year = Math.floor(yyyymmdd / 10000);
    const month = Math.floor((yyyymmdd % 10000) / 100) - 1; // Month is 1-indexed in YYYYMMDD, but 0-indexed in Date
    const day = yyyymmdd % 100;
    return new Date(Date.UTC(year, month, day));
}
/**
 * Converts Date object to a number in YYYYMMDD format
 */
export function dateToNum(date) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1; // Month is 0-indexed in Date, but 1-indexed in YYYYMMDD
    const day = date.getUTCDate();
    return year * 10000 + month * 100 + day;
}
;
function cacheFilename(path) {
    if (path.length === 0)
        return 'index.json';
    return path.join('_') + '.json';
}
/**
 * Creates a START WorkItem with two requests, one for children and one for cache.
 */
function createStartWorkItem(driveItem, path) {
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
function createEndWorkItem(item) {
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
    };
}
/**
 * Creates a GeoItem
 */
function createGeoItem(driveItem, folderIndex) {
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
        tags: (driveItem.tags ?? []).map((t) => t.name.toLowerCase()),
    };
}
/**
 * Resolves all thumbnails that haven't yet been resolved.
 */
async function resolveThumbnails(f, item) {
    let lastPct = "";
    function log(count, total, throttled) {
        const pct = `${Math.floor(count / total * 100)}%`;
        if (pct === lastPct)
            return;
        lastPct = pct;
        f(`making thumbnails ${pct}${throttled ? ' (throttled)' : ''}`);
    }
    const fetches = await rateLimitedBlobFetch(log, item.data.geoItems.filter(geo => !geo.thumbnailUrl.startsWith('data:')).map(gi => [gi.thumbnailUrl, gi]));
    for (const [blobOrError, geoItem] of fetches) {
        if (blobOrError instanceof Blob) {
            geoItem.thumbnailUrl = await blobToDataUrl(blobOrError);
        }
        else {
            console.error(`Failed to fetch thumbnail ${geoItem.thumbnailUrl}: ${blobOrError.message}`);
        }
    }
    if (fetches.length > 0 && lastPct !== '100%')
        log(100, 100, false); // so it appears as "100%"
}
/**
 * Recursive walk of all photos in the Pictures folder, reading and writing a persistent cache in OneDrive.
 * Takes ~30mins for 10 years' worth of photos.
 */
export async function indexImpl(progress, photosDriveItem) {
    const waiting = new Map();
    const toProcess = [];
    const toFetch = [createStartWorkItem(photosDriveItem, [])];
    const stats = { bytesFromCache: 0, bytesProcessed: 0, bytesTotal: photosDriveItem.size, startTime: Date.now() };
    function log(item) {
        return (s) => {
            const bar = progressBar(stats.bytesFromCache, stats.bytesProcessed, stats.bytesTotal);
            const folder = item.path.length === 0 ? ['Pictures'] : item.path;
            progress([`[${bar}]`, folder.join('/'), s || ' ']);
        };
    }
    let lastSuccessfulActivity = performance.now();
    while (true) {
        const item = toProcess.shift();
        if (item && item.state === 'START') {
            const cacheResult = item.responses[`cache-${item.data.id}`];
            const childrenResult = item.responses[`children-${item.data.id}`];
            if (childrenResult.body.error && childrenResult.body.error.code === 'activityLimitReached') {
                await new Promise(resolve => setTimeout(resolve, 10000));
                toProcess.unshift(item);
                const duration = (performance.now() - lastSuccessfulActivity) / 1000;
                log(item)(`throttling for ${duration < 300 ? Math.round(duration) + 's' : Math.round(duration / 60) + 'mins'}`);
                continue;
            }
            lastSuccessfulActivity = performance.now();
            if (childrenResult.body.error) {
                throw new FetchError(`${childrenResult.request.url}[child]`, new Response(childrenResult.body, { status: childrenResult.status }), JSON.stringify(childrenResult.body));
            }
            if (cacheResult.status === 200 && cacheResult.body.size === item.data.size && cacheResult.body.schemaVersion === SCHEMA_VERSION) {
                stats.bytesFromCache += item.data.size;
                toProcess.unshift({ ...item, data: cacheResult.body, state: 'END', requests: [], responses: {} });
                progress(cacheResult.body.geoItems);
                continue;
            }
            const cache = new Map(); // if not the whole cache, we'll at least re-use thumbnails
            if (cacheResult.status === 200) {
                const cacheGeoData = cacheResult.body;
                for (const cachedItem of cacheGeoData.geoItems.splice(0, cacheGeoData.immediateChildCount)) {
                    cache.set(cachedItem.id, cachedItem.thumbnailUrl);
                }
            }
            // Kick off subfolders, and gather immediate children (but resolving their thumbnails is deferred until our finish-action)
            for (const child of childrenResult.body.value) {
                if (child.folder) {
                    toFetch.push(createStartWorkItem(child, [...item.path, child.name]));
                    item.remainingSubfolders++;
                }
                else if (child.file) {
                    stats.bytesProcessed += child.size;
                    if (child.location && child.location.latitude && child.location.longitude && child.thumbnails?.at(0)?.small?.url && child.photo?.takenDateTime) {
                        const folderIndex = 0; // invariant: item.folders[0] will be folder of that workitem
                        const childItem = createGeoItem(child, folderIndex);
                        if (cache.has(childItem.id))
                            childItem.thumbnailUrl = cache.get(childItem.id);
                        item.data.geoItems.push(childItem);
                    }
                }
            }
            item.data.immediateChildCount = item.data.geoItems.length;
            if (item.data.immediateChildCount > 0)
                item.data.folders.push(item.path.join('/').toLowerCase());
            // Book-keeping: either our finish-action can be done now, or is done by our final subfolder.
            if (item.remainingSubfolders === 0) {
                await resolveThumbnails(log(item), item);
                progress(item.data.geoItems);
                toFetch.unshift(createEndWorkItem(item));
            }
            else {
                toFetch.sort((a, b) => cacheFilename(a.path).localeCompare(cacheFilename(b.path))); // alphabetical order to finish off subtrees quicker
                waiting.set(cacheFilename(item.path), item);
            }
        }
        else if (item && item.state === 'END') {
            log(item)();
            if (item.path.length === 0)
                return item.data; // Finished the root folder!
            // Book-keeping: if our parent's finish-action was left to us, then we'll do it now.
            // We'll have to adjust all our folder indexes. Invariant: a child's folders[] are
            // are all different from those of its parent (hence no need to dedupe).
            const parentName = cacheFilename(item.path.slice(0, -1));
            const parent = waiting.get(parentName);
            try {
                const adjustedItems = item.data.geoItems.map(gi => ({ ...gi, folderIndex: gi.folderIndex + parent.data.folders.length }));
                parent.data.geoItems = parent.data.geoItems.concat(adjustedItems);
                parent.data.folders = parent.data.folders.concat(item.data.folders);
            }
            catch (e) {
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
                }
                else {
                    const logpct = (count, total) => log(parent)(`upload ${Math.floor(count / total * 100)}%`);
                    await multipartUpload(logpct, cacheFilename(parent.path), data);
                    toProcess.unshift({ ...parent, state: 'END', responses: {}, requests: [] });
                }
            }
        }
        else {
            const thisFetch = [];
            const requests = [];
            while (toFetch.length > 0 && requests.length < 18) {
                const item = toFetch.shift();
                requests.push(...item.requests);
                thisFetch.push(item);
            }
            let batchResponse = null;
            const url = 'https://graph.microsoft.com/v1.0/$batch';
            while (true) {
                const body = JSON.stringify({ requests });
                batchResponse = await authFetch(url, {
                    'method': 'POST',
                    'headers': {
                        'Content-Type': 'application/json',
                    },
                    'body': body
                });
                if (batchResponse.status !== 429)
                    break;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            if (!batchResponse.ok)
                throw new FetchError(`${url}[POST:batch(${requests.length})]`, batchResponse, await batchResponse.text());
            const batchResult = await batchResponse.json();
            await postprocessBatchResponse(batchResult);
            for (const r of await batchResult.responses) {
                const item = thisFetch.find(item => item.requests.some(req => req.id === r.id));
                const requests = item.requests.find(req => req.id === r.id);
                r.request = requests;
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
function lngWrap(lng) {
    return (lng + 180 + 360) % 360 - 180;
}
/**
 * Returns the westmost of two longitudes -- the one that can be reached
 * from the other by travelling less than 180 degrees westwards.
 * If the two points are exactly opposite, the choice is arbitrary.
 */
function westmost(lng1, lng2) {
    // use +720 instead of +360 to allow for mild non-normalization of input values (so we still get positive distance)
    return (lng1 - lng2 + 720) % 360 < 180 ? lng2 : lng1;
}
/**
 * Returns the eastmost of two longitudes -- the one that can be reached
 * from the other by travelling less than 180 degrees eastwards.
 * If the two points are exactly opposite, the choice is arbitrary.
 */
function eastmost(lng1, lng2) {
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
export function asClusters(sw, ne, pixelWidth, geoData, filter) {
    const TILE_SIZE_PX = 60;
    const MAX_ITEMS_PER_TILE = 40;
    const tileSize = ((ne.lng - sw.lng + 360) % 360 || 360) / Math.max(1, Math.round(pixelWidth / TILE_SIZE_PX));
    const swSnap = { lat: Math.floor(sw.lat / tileSize) * tileSize, lng: lngWrap((Math.floor(sw.lng / tileSize) * tileSize)) };
    const numTilesX1 = Math.ceil(((ne.lng - swSnap.lng + 360) % 360) / tileSize);
    const numTilesX2 = Math.ceil(((ne.lng - sw.lng + 360) % 360) / tileSize);
    const numTilesX = Math.max(numTilesX1, numTilesX2); // because when fully zoomed out, swSnap.lng can become east of ne.lng!
    const numTilesY = Math.ceil((ne.lat - swSnap.lat) / tileSize);
    const tiles = [];
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
    const filterFolders = filterText === undefined ? new Set() :
        new Set(geoData.folders.map((f, i) => f.includes(filterText) ? i : -1).filter(i => i !== -1));
    const dateCounts = new Map();
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
        if (!inBounds)
            continue;
        const tile = tiles[y * numTilesX + x];
        if ((filter.text && !inFilter) || !inDateRange) {
            if (tile.oneFailFilterItem === undefined)
                tile.oneFailFilterItem = item;
            continue;
        }
        if (tile.somePassFilterItems.length < MAX_ITEMS_PER_TILE)
            tile.somePassFilterItems.push(item); // PERF: this push costs 1ms
        tile.totalPassFilterItems++;
    }
    return [tiles.filter(t => t.somePassFilterItems.length > 0 || t.oneFailFilterItem !== undefined), { dateCounts }];
}
export function boundsForDateRange(geoData, dateRange) {
    let r = undefined;
    for (const item of geoData.geoItems) {
        const inDateRange = dateRange === undefined || (item.date >= dateRange.start && item.date < dateRange.end);
        if (!inDateRange)
            continue;
        if (r === undefined) {
            r = { sw: structuredClone(item.position), ne: structuredClone(item.position) };
        }
        else {
            r.sw.lat = Math.min(r.sw.lat, item.position.lat);
            r.sw.lng = westmost(r.sw.lng, item.position.lng);
            r.ne.lat = Math.max(r.ne.lat, item.position.lat);
            r.ne.lng = eastmost(r.ne.lng, item.position.lng);
        }
    }
    return r;
}
//# sourceMappingURL=geoitem.js.map