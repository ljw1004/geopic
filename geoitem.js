import { FetchError, blobToDataUrl, multipartUpload, postprocessBatchResponse, progressBar, rateLimitedBlobFetch } from './utils.js';
;
function cacheFilename(path) {
    if (path.length === 0)
        return 'index.json';
    return path.join('-').replace(/[^a-zA-Z0-9-]/g, '_') + '.json';
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
                url: `/me/drive/items/${driveItem.id}/children?$top=10000&$expand=thumbnails&select=name,id,ctag,etag,size,lastModifiedDateTime,folder,file,location,photo,video`
            },
            {
                id: `cache-${driveItem.id}`,
                method: 'GET',
                url: `/me/drive/special/approot:/${cacheFilename(path)}:/content`
            }
        ],
        responses: {},
        data: {
            id: driveItem.id,
            path,
            size: driveItem.size,
            lastModifiedDateTime: driveItem.lastModifiedDateTime,
            cTag: driveItem.cTag,
            eTag: driveItem.eTag,
            geoItems: [],
        },
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
                url: `/me/drive/special/approot:/${cacheFilename(item.data.path)}:/content`,
                // I experimentally found weird bugs and workarounds in the batch API (not the individual API):
                // - If I upload an object with content-type application/json, OneDrive claims success but stores a file of size 0
                // - If I upload a string, or base64-encoded json string, with application/json, OneDrive fails with "Invalid json body"
                // - If I upload a base64-encoded json string as text/plain, OneDrive succeeds and stores the file, and subsequent download has content-type application/json
                body: btoa(JSON.stringify(item.data)),
                headers: { 'Content-Type': 'text/plain' }
            }
        ]
    };
}
/**
 * Creates a GeoItem
 */
function createGeoItem(driveItem) {
    const lat = Math.round(driveItem.location.latitude * 100000) / 100000;
    const lng = Math.round(driveItem.location.longitude * 100000) / 100000;
    if (isNaN(lat) || isNaN(lng)) {
        console.error(`Invalid lat/lng for driveItem. ${JSON.stringify(driveItem)}`);
    }
    return {
        id: driveItem.id,
        position: {
            lat,
            lng,
        },
        date: driveItem.photo.takenDateTime,
        thumbnailUrl: driveItem.thumbnails[0].small.url,
        aspectRatio: Math.round(driveItem.thumbnails[0].small.width / driveItem.thumbnails[0].small.height * 100) / 100,
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
        f(`[thumbnails ${pct}${throttled ? ' (throttled)' : ''}]`);
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
 * Takes ~20mins for 10 years' worth of photos.
 *
 * TODO: need to display progress nicely
 * TODO: when cache is invalid but exists, any cached geoItems (with thumbnails) are still valid and should be used.
 */
export async function generateImpl(accessToken, rootDriveItem) {
    const waiting = new Map();
    const toProcess = [];
    const toFetch = [createStartWorkItem(rootDriveItem, [])];
    const stats = { bytesFromCache: 0, bytesProcessed: 0, bytesTotal: rootDriveItem.size, startTime: Date.now() };
    function log(item) {
        return (s) => {
            const prefix = item && `${progressBar(stats.bytesFromCache, stats.bytesProcessed, stats.bytesTotal)} - ${item.data.path.length === 0 ? 'Pictures' : item.data.path.join('/')}`;
            console.log(s ? `${prefix} - ${s}` : prefix);
        };
    }
    while (true) {
        const item = toProcess.shift();
        if (item && item.state === 'START') {
            const cache = item.responses[`cache-${item.data.id}`];
            const children = item.responses[`children-${item.data.id}`];
            if (children.body.error && children.body.error.code === 'activityLimitReached') {
                await new Promise(resolve => setTimeout(resolve, 2000));
                toProcess.unshift(item);
                continue;
            }
            if (cache.status === 200 && cache.body.size === item.data.size) {
                stats.bytesFromCache += item.data.size;
                toProcess.unshift({ ...item, data: cache.body, state: 'END', requests: [], responses: {} });
                continue;
            }
            // Kick off subfolders, and gather immediate children (but resolving their thumbnails is deferred until our finish-action)
            for (const child of children.body.value) {
                if (child.folder) {
                    toFetch.push(createStartWorkItem(child, [...item.data.path, child.name]));
                    item.remainingSubfolders++;
                }
                else if (child.file) {
                    stats.bytesProcessed += child.size;
                    if (child.location && child.location.latitude && child.location.longitude && child.thumbnails?.at(0)?.small?.url && child.photo?.takenDateTime) {
                        item.data.geoItems.push(createGeoItem(child));
                    }
                }
            }
            // Book-keeping: either our finish-action can be done now, or is done by our final subfolder.
            if (item.remainingSubfolders === 0) {
                await resolveThumbnails(log(item), item);
                toFetch.unshift(createEndWorkItem(item));
            }
            else {
                toFetch.sort((a, b) => cacheFilename(a.data.path).localeCompare(cacheFilename(b.data.path)));
                waiting.set(cacheFilename(item.data.path), item);
            }
        }
        else if (item && item.state === 'END') {
            log(item)();
            if (item.data.path.length === 0)
                return item.data; // Finished the root folder!
            // Book-keeping: if our parent's finish-action was left to us, then we'll do it now.
            const parentName = cacheFilename(item.data.path.slice(0, -1));
            const parent = waiting.get(parentName);
            parent.data.geoItems.push(...item.data.geoItems);
            parent.remainingSubfolders--;
            if (parent.remainingSubfolders === 0) {
                await resolveThumbnails(log(parent), parent);
                waiting.delete(parentName);
                const data = JSON.stringify(parent.data);
                if (data.length < 4 * 1024 * 1024) {
                    toFetch.unshift(createEndWorkItem(parent));
                }
                else {
                    const logpct = (count, total) => log(parent)(`[upload ${Math.floor(count / total * 100)}%]`);
                    await multipartUpload(logpct, cacheFilename(parent.data.path), data, accessToken);
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
            while (true) {
                const body = JSON.stringify({ requests });
                batchResponse = await fetch('https://graph.microsoft.com/v1.0/$batch', {
                    'method': 'POST',
                    'headers': {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`
                    },
                    'body': body
                });
                if (batchResponse.status !== 429)
                    break;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            if (!batchResponse.ok)
                throw new FetchError(batchResponse, await batchResponse.text());
            const batchResult = await batchResponse.json();
            await postprocessBatchResponse(batchResult);
            for (const r of await batchResult.responses) {
                const item = thisFetch.find(item => item.requests.some(req => req.id === r.id));
                item.responses[r.id] = r;
            }
            thisFetch.forEach(item => item.requests = []);
            toProcess.push(...thisFetch);
        }
    }
}
//# sourceMappingURL=geoitem.js.map