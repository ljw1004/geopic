import { fetchAsync } from './index.js';
import { fetchAsDataUrl, postprocessBatchResponse } from './utils.js';

/**
 * This object contains everything we we need for a folder to (1) cache and validate cache, (2) display thumbnails on a map.
 * This object will be serialized to JSON and stored on OneDrive.
 */
interface CacheData {
    id: string; // OneDrive ID of this folder
    path: string[]; // Used by both the workitem processing algorithm (to find parents), and for debugging
    size: number; // for cache validation
    lastModifiedDateTime: string; // for cache validation
    cTag: string; // for cache validation
    eTag: string; // for cache validation

    geoItems: GeoItem[];
}

/**
 * An individual photo/video with geolocation data.
 */
interface GeoItem {
    position: {
        lat: number;
        lng: number;
    };
    date: string; // ISO date string for JSON serialization compatibility
    thumbnailUrl: string;
    id: string;
    aspectRatio: number;
}

/**
 * Workitems are stored in these structures:
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
    data: CacheData; // initialized upon creation with an empty list of geoItems; processor will append to the list
    remainingSubfolders: number; // if cache/geoItems is incomplete, this is how many subfolders it still needs
};

function cacheFilename(path: string[]): string {
    if (path.length === 0) return 'all.json';
    return path.join('-').replace(/[^a-zA-Z0-9-]/g, '_') + '.json';
}


/**
 * Creates a START WorkItem with two requests, one for children and one for cache.
 */
function createWorkItem(driveItem: any, path: string[]): WorkItem {
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
function createEndWorkItem(item: WorkItem): WorkItem {
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
    }
}


/**
 * Creates a GeoItem. But with its thumbnailDataUrl not yet fetched (it's just the URL of the thumbnail content).
 */
function createGeoItem(driveItem: any): GeoItem {
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
async function resolveDataUrls(item: WorkItem): Promise<void> {
    const THROTTLE = 10; // max concurrent fetches
    let index = 0;
    const promises = new Map<number, Promise<number>>();
    while (index < item.data.geoItems.length) {
        if (promises.size >= THROTTLE) promises.delete(await Promise.any(promises.values()));
        const thisIndex = index++;
        const geoItem = item.data.geoItems[thisIndex];
        if (geoItem.thumbnailUrl.startsWith('data:')) continue;
        const promise = fetchAsDataUrl(geoItem.thumbnailUrl).then(dataUrl => {
            geoItem.thumbnailUrl = dataUrl;
            return thisIndex;
        });
        promises.set(thisIndex, promise);
    }
    await Promise.all(promises.values());
}

export async function testWalk(): Promise<WorkItem> {
    const toProcess: WorkItem[] = [];
    const toFetch: WorkItem[] = [];
    const waiting = new Map<string, WorkItem>();
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
                } else if (child.file) {
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
            } else {
                toFetch.unshift(createEndWorkItem(item));
            }
        } else if (item && item.state === 'END') {
            console.log(`[${Math.round(stats.bytesProgress / stats.bytesTotal * 100)}%] - in this run ${stats.foldersFoundInCache} folders from cache, ${stats.foldersProcessed} folders processed, ${stats.filesProcessed} files processed - ${item.data.path.join('/')}`);
            if (item.data.path.length === 0) {
                console.log("DONE!!!");
                return item; // we've done the root folder!
            }
            const parentName = cacheFilename(item.data.path.slice(0, -1))
            const parent = waiting.get(parentName)!;
            parent.data.geoItems.push(...item.data.geoItems);
            parent.remainingSubfolders--;
            if (parent.remainingSubfolders === 0) {
                waiting.delete(parentName);
                toFetch.unshift(createEndWorkItem(parent));
            }
        } else {
            const thisFetch: WorkItem[] = [];
            const requests: any[] = [];
            while (toFetch.length > 0 && requests.length < 18) {
                const item = toFetch.shift()!;
                requests.push(...item.requests);
                thisFetch.push(item);
            }
            const response = await fetchAsync('POST', 'https://graph.microsoft.com/v1.0/$batch', JSON.stringify({ requests }), 'application/json');
            await postprocessBatchResponse(response);
            for (const r of await response.responses) {
                const item = thisFetch.find(item => item.requests.some(req => req.id === r.id))!;
                item.responses[r.id] = r;
            }
            thisFetch.forEach(item => item.requests = []);
            toProcess.push(...thisFetch);
        }
    }

}

export async function testFetch(): Promise<void> {
    const r = await fetchAsync('GET',
        `https://graph.microsoft.com/v1.0/me/drive/items/92917DCE344E62BC!342443/children?$expand=thumbnails&$select=id,name,size,folder,lastModifiedDateTime,cTag,eTag`);
    console.log(JSON.stringify(r, null, 2));
}

export async function testCache(): Promise<any> {
    const appFolderResponse = await fetchAsync('GET', 'https://graph.microsoft.com/v1.0/me/drive/special/approot');
    console.log('App folder ID:', appFolderResponse.id);

    const data = { foo: 1, bar: { a: 2, b: 3 } };
    const writeResponse = await fetchAsync('PUT',
        `https://graph.microsoft.com/v1.0/me/drive/special/approot:/file1.json:/content`, JSON.stringify(data), 'application/json'
    );
    console.log(JSON.stringify(writeResponse, null, 2));

    const readResponse = await fetchAsync('GET',
        `https://graph.microsoft.com/v1.0/me/drive/special/approot:/file1.json:/content`);
    console.log(JSON.stringify(readResponse, null, 2));
}

export async function testBatch(): Promise<any> {
    const folderIds: string[] = [
        "92917DCE344E62BC!342443",
        "92917DCE344E62BC!324268",
        "92917DCE344E62BC!324269",
        "92917DCE344E62BC!76025",
        "92917DCE344E62BC!325738",
    ];
    const readFiles: string[] = ["file1.json", "file2.json"];
    const writeFiles: string[] = ["file3.json", "file4.json"];
    const folderRequests = folderIds.map((id: string) => ({
        id: `folder-${id}`,
        method: 'GET',
        url: `/me/drive/items/${id}`
    }));
    const readRequests = readFiles.map((name: string) => ({
        id: `read-${name}`,
        method: 'GET',
        url: `/me/drive/special/approot:/${name}:/content`
    }));
    const writeRequests = writeFiles.map((name: string) => ({
        id: `write-${name}`,
        method: 'PUT',
        url: `/me/drive/special/approot:/${name}:/content`,
        body: btoa(JSON.stringify({ foo: 1, bar: 2 })),
        headers: { 'Content-Type': 'text/plain' } // OneDrive bug workaround
    }));

    const batch1Response = await fetchAsync('POST', 'https://graph.microsoft.com/v1.0/$batch',
        JSON.stringify({ requests: [...readRequests, ...writeRequests, ...folderRequests] }), 'application/json');
    console.log(JSON.stringify(await postprocessBatchResponse(batch1Response), null, 2));
}

