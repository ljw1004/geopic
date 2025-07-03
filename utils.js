export class FetchError extends Error {
    response;
    constructor(response, text) {
        super(`HTTP ${response.status} ${response.statusText}: ${text}`);
        this.response = response;
        Error.captureStackTrace(this, FetchError);
    }
}
export function blobToDataUrl(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}
/**
 * This helper cleans up some idiosyncrasies of the batch response:
 * 1. GET :/content usually returns 302 redirect, which "fetch" follows automatically, but "batch" doesn't.
 *    This functino therefore follows redirects. Similar to fetchAsync, the body is either JSON object or string,
 *    depending on whether content-type includes 'application/json'.
 * 2. GET :/content with error response, and PUT :/content with its driveItem response, claim to return application/json body.
 *    They do that when fetched individually. But in the batch response, they return a base64-encoded string of that json.
 *    This is mentioned here https://learn.microsoft.com/en-us/answers/questions/1352007/using-batching-with-the-graph-api-returns-the-body
 *    Problem is, there's no generic way for us to tell! What if the response itself truly was base64?
 *    what if the response was a real string which also happened to be base-64 decodable?
 *    We'll recover one common case (where the response claims to be content-type application/json but it's a string),
 *    but it's all heuristic and you're basically on your own.
 *
 * This function modifies its argument in place, and also returns it for convenience.
 */
export async function postprocessBatchResponse(response) {
    const promises = [];
    for (const r of response.responses) {
        if (r.status === 302) { // redirect
            promises.push(fetch(r["headers"]["Location"]).then(async (rr) => {
                r.headers = {};
                rr.headers.forEach((value, key) => r.headers[key] = value);
                r.status = rr.status;
                try {
                    r.body = (rr.headers.get('Content-Type')?.includes('application/json')) ? await rr.json() : await rr.text();
                }
                catch (e) {
                    console.log(String(e));
                }
            }));
        }
        else if (r["headers"]?.["Content-Type"]?.includes('application/json') && typeof r.body === 'string') {
            r.body = JSON.parse(atob(r.body));
        }
    }
    await Promise.all(promises);
    return response;
}
/**
 * Converts seconds to human-readable format (e.g., "1h 23m 45s", "2m 30s", "45s")
 */
export function formatDuration(seconds) {
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    }
    else if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
    }
    else {
        return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m${Math.round(seconds % 60)}s`;
    }
}
/**
 * This fetches blobs from the given URLs. It retries upon "429 too busy", but all other result codes are returned to caller.
 * The result is either a Blob or a non-429 FetchError for each item, in the order they were provided.
 */
export async function rateLimitedBlobFetch(f, urls) {
    // We will use indices into urls[] array. The indices in this array never change.
    // results: has identical indices as urls[]
    // queue: this array stores those indices, e.g. [0,2,1] means that indices 0,2,1 still have to be processed. They can and will end up out of order.
    // fetches: this maps from an index, to a promise representing an outstanding fetch for that index's url
    const results = urls.map(([_, t]) => [undefined, t]);
    const queue = Array(urls.length).fill(0).map((_, i) => i);
    const fetches = new Map(); // uses the same index as its key
    // Rate limiting: it starts out aggressive with 6 concurrent requests (the maximum allowed by Chrome).
    // If it gets "429 too busy" then it scales back to 1 concurrent request. If it still gets 429 then it delays 10s between requests.
    // If it gets "200 success" then it cuts delay to 0. If it still gets 200 then it increases concurrency by 1 up to maximum 6.
    // Invariant: (concurrencyLimit,retryDelay) is either (n,0) or (1,10) for 1<=n<=6.
    let concurrencyLimit = 6;
    let retryDelay = 0;
    while (queue.length > 0 || fetches.size > 0) {
        f(urls.length - queue.length - fetches.size, urls.length, retryDelay > 0 || concurrencyLimit < 6);
        // Kick off fetches as needed
        while (fetches.size < concurrencyLimit) {
            const i = queue.shift();
            if (i === undefined)
                break;
            await new Promise(resolve => setTimeout(resolve, retryDelay * 1000)); // because of invariant, we'll only delay in cases where loop executes just once
            fetches.set(i, fetch(urls[i][0]).then(async (r) => ({ i, r: r.ok ? await r.blob() : new FetchError(r, await r.text()) })));
        }
        // At this point fetches is guaranteed non-empty. (the above code only ever grew it)
        const { i, r } = await Promise.any(fetches.values());
        fetches.delete(i);
        // Rate-limiting adjustment (up or down) and store/retry the result
        if (r instanceof Blob) {
            if (retryDelay > 0)
                retryDelay = 0;
            else if (concurrencyLimit < 6)
                concurrencyLimit++;
            results[i][0] = r;
        }
        else if (r instanceof FetchError && r.response.status == 429) {
            if (concurrencyLimit > 1)
                concurrencyLimit = 1;
            else
                retryDelay = 10;
            queue.push(i);
        }
        else {
            results[i][0] = r;
        }
    }
    return results;
}
/**
 * Minimal use of IndexedDB which contains only a single object store 'table1', and callers are responsible for keys
 */
async function dbOpen() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('geopic-cache', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (db.objectStoreNames.contains('table1'))
                db.deleteObjectStore('table1');
            db.createObjectStore('table1');
        };
    });
}
/**
 * Stores a single object in IndexedDB.
 */
export async function dbPut(data) {
    const db = await dbOpen();
    try {
        const transaction = db.transaction(['table1'], 'readwrite');
        const cacheStore = transaction.objectStore('table1');
        await new Promise((resolve, reject) => {
            const req = cacheStore.put(data, 1);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
    finally {
        db.close();
    }
}
/**
 * Retrieves a single object from IndexedDB.
 */
export async function dbGet() {
    const db = await dbOpen();
    try {
        const transaction = db.transaction(['table1'], 'readonly');
        const cacheStore = transaction.objectStore('table1');
        const data = await new Promise((resolve, reject) => {
            const req = cacheStore.get(1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return data;
    }
    finally {
        db.close();
    }
}
/**
 * Returns a 20-character-wide progress bar string that looks like this:
 *   "===-->            "
 *   "==---15%-->       "
 *   "=======12%==>     "
 * There are '=' characters up to the count1/total fraction of the bar
 * There are '-' characters from there to the (count1+count2)/total fraction of the bar
 * There's a '>' character after all of them
 * If there are at least 6 '=' or '-' characters, then a two-digit percentage replaces near the end.
 */
export function progressBar(count1, count2, total) {
    const barWidth = 20;
    const equalsCount = Math.floor(count1 / total * barWidth);
    const dashCount = Math.floor((count1 + count2) / total * barWidth) - equalsCount;
    const emptyCount = barWidth - equalsCount - dashCount - 1;
    let bar = '='.repeat(equalsCount) + '-'.repeat(dashCount) + '>' + '.'.repeat(emptyCount);
    const pct = Math.floor((count1 + count2) / total * 100).toString() + '%';
    const pos = equalsCount + dashCount >= 5 ? equalsCount + dashCount - 4 : equalsCount + dashCount + 3;
    return `[${bar.substring(0, pos)}${pct}${bar.substring(pos + pct.length)}]`;
}
//# sourceMappingURL=utils.js.map