import { fetchAsync } from './index.js';
import { fetchAsDataUrl, postprocessBatchResponse } from './utils.js';
;
function cacheFilename(path) {
    if (path.length === 0)
        return 'all.json';
    return path.join('-').replace(/[^a-zA-Z0-9-]/g, '_') + '.json';
}
/**
 * Creates a START WorkItem with two requests, one for children and one for cache.
 */
function createWorkItem(driveItem, path) {
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
 * Creates an END workitem with one request, to write the cache
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
 * Creates a GeoItem. But with its thumbnailDataUrl not yet fetched (it's just the URL of the thumbnail content).
 */
function createGeoItem(driveItem) {
    return {
        id: driveItem.id,
        position: {
            lat: Math.round(driveItem.location.latitude * 100000) / 100000,
            lng: Math.round(driveItem.location.longitude * 100000) / 100000,
        },
        date: driveItem.photo.takenDateTime,
        thumbnailUrl: driveItem.thumbnails[0].small.url,
        aspectRatio: Math.round(driveItem.thumbnails[0].small.width / driveItem.thumbnails[0].small.height * 100) / 100,
    };
}
/**
 * Given a workitem, this concurrently fetches thumbnail URLs to replace them with data URLs.
 */
async function resolveDataUrls(item) {
    const THROTTLE = 10; // max concurrent fetches
    let index = 0;
    const promises = new Map();
    while (index < item.data.geoItems.length) {
        if (promises.size >= THROTTLE)
            promises.delete(await Promise.any(promises.values()));
        const thisIndex = index++;
        const geoItem = item.data.geoItems[thisIndex];
        if (geoItem.thumbnailUrl.startsWith('data:'))
            continue;
        const promise = fetchAsDataUrl(geoItem.thumbnailUrl).then(dataUrl => {
            geoItem.thumbnailUrl = dataUrl;
            return thisIndex;
        });
        promises.set(thisIndex, promise);
    }
    await Promise.all(promises.values());
}
export async function testWalk() {
    const toProcess = [];
    const toFetch = [];
    const waiting = new Map();
    const stats = { foldersFoundInCache: 0, foldersProcessed: 0, filesProcessed: 0, filesProgress: 0, bytesProgress: 0, bytesTotal: 0, startTime: Date.now() };
    const rootDriveItem = await fetchAsync('GET', `https://graph.microsoft.com/v1.0/me/drive/special/photos`);
    toFetch.push(createWorkItem(rootDriveItem, []));
    stats.bytesTotal = rootDriveItem.size;
    while (true) {
        const item = toProcess.shift();
        if (item && item.state === 'START') {
            const cache = item.responses[`cache-${item.data.id}`];
            const children = item.responses[`children-${item.data.id}`];
            if (cache.status === 200 && cache.body.size === item.data.size) {
                stats.filesProgress += cache.body.geoItems.length;
                stats.foldersFoundInCache++;
                toProcess.unshift({ ...item, state: 'END', requests: [], responses: {} });
                continue;
            }
            for (const child of children.body.value) {
                if (child.folder) {
                    toFetch.push(createWorkItem(child, [...item.data.path, child.name]));
                    item.remainingSubfolders++;
                }
                else if (child.file) {
                    stats.bytesProgress += child.size;
                    if (child.location && child.thumbnails?.at(0)?.small?.url && child.photo?.takenDateTime) {
                        item.data.geoItems.push(createGeoItem(child));
                    }
                }
            }
            await resolveDataUrls(item);
            stats.filesProgress += item.data.geoItems.length;
            stats.filesProcessed += item.data.geoItems.length;
            stats.foldersProcessed++;
            if (item.remainingSubfolders > 0) {
                toFetch.sort((a, b) => cacheFilename(a.data.path).localeCompare(cacheFilename(b.data.path)));
                waiting.set(cacheFilename(item.data.path), item);
            }
            else {
                toFetch.unshift(createEndWorkItem(item));
            }
        }
        else if (item && item.state === 'END') {
            console.log(`[${Math.round(stats.bytesProgress / stats.bytesTotal * 100)}%] - in this run ${stats.foldersFoundInCache} folders from cache, ${stats.foldersProcessed} folders processed, ${stats.filesProcessed} files processed - ${item.data.path.join('/')}`);
            if (item.data.path.length === 0) {
                console.log("DONE!!!");
                return item; // we've done the root folder!
            }
            const parentName = cacheFilename(item.data.path.slice(0, -1));
            const parent = waiting.get(parentName);
            parent.data.geoItems.push(...item.data.geoItems);
            parent.remainingSubfolders--;
            if (parent.remainingSubfolders === 0) {
                waiting.delete(parentName);
                toFetch.unshift(createEndWorkItem(parent));
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
            const response = await fetchAsync('POST', 'https://graph.microsoft.com/v1.0/$batch', JSON.stringify({ requests }), 'application/json');
            await postprocessBatchResponse(response);
            for (const r of await response.responses) {
                const item = thisFetch.find(item => item.requests.some(req => req.id === r.id));
                item.responses[r.id] = r;
            }
            thisFetch.forEach(item => item.requests = []);
            toProcess.push(...thisFetch);
        }
    }
}
export async function testFetch() {
    const r = await fetchAsync('GET', `https://graph.microsoft.com/v1.0/me/drive/items/92917DCE344E62BC!342443/children?$expand=thumbnails&$select=id,name,size,folder,lastModifiedDateTime,cTag,eTag`);
    console.log(JSON.stringify(r, null, 2));
}
export async function testCache() {
    const appFolderResponse = await fetchAsync('GET', 'https://graph.microsoft.com/v1.0/me/drive/special/approot');
    console.log('App folder ID:', appFolderResponse.id);
    const data = { foo: 1, bar: { a: 2, b: 3 } };
    const writeResponse = await fetchAsync('PUT', `https://graph.microsoft.com/v1.0/me/drive/special/approot:/file1.json:/content`, JSON.stringify(data), 'application/json');
    console.log(JSON.stringify(writeResponse, null, 2));
    const readResponse = await fetchAsync('GET', `https://graph.microsoft.com/v1.0/me/drive/special/approot:/file1.json:/content`);
    console.log(JSON.stringify(readResponse, null, 2));
}
export async function testBatch() {
    const folderIds = [
        "92917DCE344E62BC!342443",
        "92917DCE344E62BC!324268",
        "92917DCE344E62BC!324269",
        "92917DCE344E62BC!76025",
        "92917DCE344E62BC!325738",
    ];
    const readFiles = ["file1.json", "file2.json"];
    const writeFiles = ["file3.json", "file4.json"];
    const folderRequests = folderIds.map((id) => ({
        id: `folder-${id}`,
        method: 'GET',
        url: `/me/drive/items/${id}`
    }));
    const readRequests = readFiles.map((name) => ({
        id: `read-${name}`,
        method: 'GET',
        url: `/me/drive/special/approot:/${name}:/content`
    }));
    const writeRequests = writeFiles.map((name) => ({
        id: `write-${name}`,
        method: 'PUT',
        url: `/me/drive/special/approot:/${name}:/content`,
        body: btoa(JSON.stringify({ foo: 1, bar: 2 })),
        headers: { 'Content-Type': 'text/plain' } // OneDrive bug workaround
    }));
    const batch1Response = await fetchAsync('POST', 'https://graph.microsoft.com/v1.0/$batch', JSON.stringify({ requests: [...readRequests, ...writeRequests, ...folderRequests] }), 'application/json');
    console.log(JSON.stringify(await postprocessBatchResponse(batch1Response), null, 2));
}
//# sourceMappingURL=test.js.map