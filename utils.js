/**
 * Copyright (c) Lucian Wischik
 */
export class FetchError extends Error {
    response;
    constructor(url, response, text) {
        super(`HTTP ${response.status} ${response.statusText} - ${url} - ${text}`);
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
 *    This function therefore follows redirects. Similar to fetchAsync, the body is either JSON object or string,
 *    depending on whether content-type includes 'application/json'.
 * 2. GET :/content with error response, and PUT :/content with its driveItem response, claim to return application/json body.
 *    They do that when fetched individually. But in the batch response, they return a base64-utf8-encoded string of that json.
 *    This is mentioned here https://learn.microsoft.com/en-us/answers/questions/1352007/using-batching-with-the-graph-api-returns-the-body
 *    Problem is, there's no generic way for us to tell! What if the response itself truly was base64?
 *    what if the response was a real string which also happened to be base-64 decodable?
 *    We'll recover one common case (where the response claims to be content-type application/json but it's a string),
 *    but it's all heuristic and you're basically on your own.
 *
 * This function modifies its argument in place, and also returns it for convenience.
 */
export async function postprocessBatchResponse(response, retryOn429) {
    const promises = [];
    for (const r of response.responses) {
        if (r.status === 302) { // redirect
            promises.push(myFetch(r["headers"]["Location"], retryOn429).then(async (rr) => {
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
            r.body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.body), (m) => m.codePointAt(0))));
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
 * Turns an exception into a Response. Helpful if you're invoking fetch()
 * and you want to have just a single common error handler, both for errors
 * that came from the server and for errors that came from the attempted fetch.
 */
export function errorResponse(url, e) {
    const message = `${e instanceof Error ? e.message : String(e)} (${url})`;
    return new Response(message, { status: 503, statusText: 'Cannot make request' });
}
/**
 * Like fetch(), but failures that throw exceptions are also reported as Response errors.
 * The retryOn429 callback is called upon "429 Too Many Requests" or "503 Service Unavailable".
 * If it returns false, this function returns the 429/503 response directly.
 * If it returns true, this function waits 2s for 429, 10s for 503, and retries the request.
 */
export async function myFetch(url, retryOn429, options) {
    while (true) {
        try {
            const r = await fetch(url, options);
            if ((r.status !== 429 && r.status != 503) || !retryOn429())
                return r;
            await new Promise(resolve => setTimeout(resolve, r.status === 429 ? 2000 : 10000));
        }
        catch (e) {
            return errorResponse(url, e);
        }
    }
}
/**
 * A possible retryOn429 strategy, for myFetch. This one disallows retries.
 */
export function noRetryOn429() {
    return false;
}
/**
 * A possible retryOn429 strategy, for myFetch. This one retries indefinitely.
 */
export function indefinitelyRetryOn429() {
    console.warn('429 Too Many Requests or 503 Service Unavailable: will retry...');
    return true;
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
            const fetch = myFetch(urls[i][0], noRetryOn429).
                then(async (r) => {
                try {
                    if (r.ok) {
                        const blob = await r.blob();
                        return { i, r: blob };
                    }
                    else {
                        const err = new FetchError(`${urls[i][0]}[rateLimitedBlob]`, r, await r.text());
                        return { i, r: err };
                    }
                }
                catch (e) {
                    return { i, r: new FetchError(`${urls[i][0]}[rateLimitedBlobException]`, errorResponse(urls[i][0], e), String(e)) };
                }
            });
            fetches.set(i, fetch);
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
 * Returns a 30-character-wide progress bar string that looks like this:
 *   "5%>               "
 *   "10%>              "
 *   "25%->             "
 *   "-30%->            "
 *   "==40%->           "
 *   "==---50%->        "
 *   "=======60%=>      "
 *   "==========--100%->"
 * It's made up of `line*, number, %, line?, >, spaces*`
 * The '=' characters go up to the count1/total fraction of the bar
 * and the '-' characters from there to the (count1+count2)/total fraction of the bar
 */
export function progressBar(count1, count2, total) {
    const BAR_WIDTH = 30;
    const equalsCount = Math.floor(count1 / total * BAR_WIDTH);
    const dashCount = Math.floor((count1 + count2) / total * BAR_WIDTH) - equalsCount;
    const lines = '='.repeat(equalsCount) + '-'.repeat(dashCount);
    const pct = Math.floor((count1 + count2) / total * 100).toString() + '%';
    if (lines.length < pct.length + 2)
        return pct + '>' + '.'.repeat(BAR_WIDTH - pct.length - 1);
    const bar = (lines.slice(0, lines.length - pct.length - 2) + pct + lines[lines.length - 2]).substring(0, BAR_WIDTH - 1) + '>';
    return bar + '.'.repeat(BAR_WIDTH - bar.length);
}
/**
 * A multipart file uploader. This can be used for large files.
 * (Batch allows up to 4mb, PUT allows up to 250mb, multipart is unlimited).
 * The way multipart upload works is chunks up to 60mb get uploaded, and they
 * must come in order one after the other. The sweet spot is apparently 10mb.
 */
export async function multipartUpload(log, name, data) {
    const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB chunks (must be multiple of 320 KiB, which this is)
    const bytes = new TextEncoder().encode(data);
    const url = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${name}:/createUploadSession`;
    const r = await authFetch(url, indefinitelyRetryOn429, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            item: {
                '@microsoft.graph.conflictBehavior': 'replace',
            }
        })
    });
    if (!r.ok)
        throw new FetchError(`${url}[multipartUpload.create]`, r, await r.text());
    log(0, bytes.length);
    const uploadUrl = (await r.json()).uploadUrl;
    for (let start = 0; start < bytes.length; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE, bytes.length); // exclusive
        const r = await myFetch(uploadUrl, indefinitelyRetryOn429, {
            method: 'PUT',
            headers: {
                'Content-Length': String(end - start),
                'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}`
            },
            body: bytes.slice(start, end)
        });
        if (!r.ok)
            throw new FetchError(`${uploadUrl}[multipartUpload.upload#${start / CHUNK_SIZE}]`, r, await r.text());
        log(end, bytes.length);
    }
}
export function escapeHtml(unsafe) {
    const div = document.createElement('div');
    div.textContent = unsafe;
    return div.innerHTML;
}
/**
 * OAuth2 code flow: here, we've been redirected back from a Microsoft login page
 * with a ?code= parameter, and this function exchanges it for an access token
 * and refresh token.
 * The code_verifier was generated by us earlier during the Login click.
 */
export async function exchangeCodeForToken(CLIENT_ID, code, code_verifier) {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        code,
        code_verifier,
        redirect_uri: window.location.origin + window.location.pathname,
        grant_type: 'authorization_code'
    });
    const url = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    const response = await myFetch(url, indefinitelyRetryOn429, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });
    if (!response.ok)
        return new FetchError(`${url}[exchangeCodeForToken]`, response, await response.text());
    const tokenData = await response.json();
    return { accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token };
}
/**
 * A simple signal object
 */
class AuthRefreshSignal {
    willSomeoneSignal = false;
    waiting = [];
    /**
     * Waits until someone signals. Should only be called if willSomeoneSignal is true.
     */
    wait() {
        return new Promise(resolve => this.waiting.push(resolve));
    }
    /**
     * Causes all waiting promises to resolve. Should only be called if you had earlier
     * set willSomeoneSignal to true (because it's you who is going to signal).
     */
    signal() {
        this.willSomeoneSignal = false;
        this.waiting.forEach(r => r());
    }
}
const AUTH_REFRESH_SIGNAL = new AuthRefreshSignal();
/**
 * This function is like fetch(), but it deals with OAuth2 code-flow authentication:
 * - It sends a header "Authorization: Bearer <access_token>" using the access_token in localStorage
 * - If this fails with 401 Unauthorized, it attempts to refresh the access token and try again.
 * - If someone else is busy doing a refresh, it waits for the refresh to finish before trying.
 */
export async function authFetch(url, retryOn429, options) {
    function f() {
        const accessToken = localStorage.getItem('access_token');
        if (!accessToken)
            return Promise.resolve(new Response('Unauthorized: no access_token', { status: 401, statusText: 'Unauthorized' }));
        options = options ? { ...options } : {};
        options.headers = new Headers(options.headers);
        options.headers.set('Authorization', `Bearer ${accessToken}`);
        return myFetch(url, retryOn429, options);
    }
    const CLIENT_ID = localStorage.getItem('client_id');
    if (!CLIENT_ID)
        return Promise.resolve(new Response('Bad request: no client_id', { status: 400, statusText: 'Bad Request' }));
    if (AUTH_REFRESH_SIGNAL.willSomeoneSignal)
        await AUTH_REFRESH_SIGNAL.wait();
    const r = await f();
    if (r.status !== 401)
        return r;
    // 401 Unauthorized.
    if (AUTH_REFRESH_SIGNAL.willSomeoneSignal) {
        await AUTH_REFRESH_SIGNAL.wait(); // wait until they finished their refresh
        return f();
    }
    // We'll do the refresh
    AUTH_REFRESH_SIGNAL.willSomeoneSignal = true;
    try {
        const refreshToken = localStorage.getItem('refresh_token');
        if (!refreshToken)
            return Promise.resolve(new Response('Unauthorized: no refresh_token', { status: 401, statusText: 'Unauthorized' }));
        const url = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
        const r = await myFetch(url, noRetryOn429, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
                scope: 'files.readwrite offline_access',
            }).toString()
        });
        if (!r.ok) {
            localStorage.removeItem('access_token');
            localStorage.removeItem('refresh_token');
            return r;
        }
        const tokenData = await r.json();
        localStorage.setItem('access_token', tokenData.access_token);
        localStorage.setItem('refresh_token', tokenData.refresh_token);
    }
    catch (e) {
        return errorResponse(url, e);
    }
    finally {
        AUTH_REFRESH_SIGNAL.signal();
    }
    return f();
}
//# sourceMappingURL=utils.js.map