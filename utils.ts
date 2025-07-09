export class FetchError extends Error {
    response: Response;
    constructor(response: Response, text: string) {
        super(`HTTP ${response.status} ${response.statusText}: ${text}`);
        this.response = response;
        (Error as any).captureStackTrace(this, FetchError);
    }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = (): void => resolve(reader.result as string);
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
export async function postprocessBatchResponse(response: any): Promise<any> {
    const promises: Promise<void>[] = [];
    for (const r of response.responses) {
        if (r.status === 302) { // redirect
            promises.push(fetch(r["headers"]["Location"]).then(async (rr) => {
                r.headers = {};
                rr.headers.forEach((value, key) => r.headers[key] = value);
                r.status = rr.status;
                try {
                    r.body = (rr.headers.get('Content-Type')?.includes('application/json')) ? await rr.json() : await rr.text();
                } catch (e) {
                    console.log(String(e));
                }
            }));
        }
        else if (r["headers"]?.["Content-Type"]?.includes('application/json') && typeof r.body === 'string') {
            r.body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.body), (m) => m.codePointAt(0) as number)));
        }
    }
    await Promise.all(promises);
    return response;
}

/**
 * Converts seconds to human-readable format (e.g., "1h 23m 45s", "2m 30s", "45s")
 */
export function formatDuration(seconds: number): string {
    if (seconds < 60) {
        return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
    } else {
        return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m${Math.round(seconds % 60)}s`;
    }
}


/**
 * This fetches blobs from the given URLs. It retries upon "429 too busy", but all other result codes are returned to caller.
 * The result is either a Blob or a non-429 FetchError for each item, in the order they were provided.
 */
export async function rateLimitedBlobFetch<T>(f: (count: number, total: number, throttled: boolean) => void, urls: [string, T][]): Promise<[Blob | FetchError, T][]> {
    // We will use indices into urls[] array. The indices in this array never change.
    // results: has identical indices as urls[]
    // queue: this array stores those indices, e.g. [0,2,1] means that indices 0,2,1 still have to be processed. They can and will end up out of order.
    // fetches: this maps from an index, to a promise representing an outstanding fetch for that index's url
    const results: [Blob | FetchError, T][] = urls.map(([_, t]) => [undefined as unknown as Blob, t]);
    const queue: number[] = Array(urls.length).fill(0).map((_, i) => i);
    const fetches: Map<number, Promise<{ r: Blob | FetchError, i: number }>> = new Map(); // uses the same index as its key

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
            if (i === undefined) break;
            await new Promise(resolve => setTimeout(resolve, retryDelay * 1000)); // because of invariant, we'll only delay in cases where loop executes just once
            fetches.set(i, fetch(urls[i][0]).
                then(async r => ({ i, r: r.ok ? await r.blob() : new FetchError(r, await r.text()) })).
                catch(e => e)
            );
        }
        // At this point fetches is guaranteed non-empty. (the above code only ever grew it)
        const { i, r } = await Promise.any(fetches.values());
        fetches.delete(i);

        // Rate-limiting adjustment (up or down) and store/retry the result
        if (r instanceof Blob) {
            if (retryDelay > 0) retryDelay = 0; else if (concurrencyLimit < 6) concurrencyLimit++;
            results[i][0] = r;
        } else if (r instanceof FetchError && r.response.status == 429) {
            if (concurrencyLimit > 1) concurrencyLimit = 1; else retryDelay = 10;
            queue.push(i);
        } else {
            results[i][0] = r;
        }
    }
    return results;
}

/**
 * Minimal use of IndexedDB which contains only a single object store 'table1', and callers are responsible for keys
 */
async function dbOpen(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('geopic-cache', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (db.objectStoreNames.contains('table1')) db.deleteObjectStore('table1');
            db.createObjectStore('table1');
        };
    });
}

/**
 * Stores a single object in IndexedDB.
 */
export async function dbPut(data: any): Promise<void> {
    const db = await dbOpen();
    try {
        const transaction = db.transaction(['table1'], 'readwrite');
        const cacheStore = transaction.objectStore('table1');
        await new Promise<void>((resolve, reject) => {
            const req = cacheStore.put(data, 1);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

/**
 * Retrieves a single object from IndexedDB.
 */
export async function dbGet<T>(): Promise<T | undefined> {
    const db = await dbOpen();
    try {
        const transaction = db.transaction(['table1'], 'readonly');
        const cacheStore = transaction.objectStore('table1');
        const data = await new Promise<T | undefined>((resolve, reject) => {
            const req = cacheStore.get(1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return data;
    } finally {
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
export function progressBar(count1: number, count2: number, total: number) {
    const BAR_WIDTH = 30;
    const equalsCount = Math.floor(count1 / total * BAR_WIDTH);
    const dashCount = Math.floor((count1 + count2) / total * BAR_WIDTH) - equalsCount;
    const lines = '='.repeat(equalsCount) + '-'.repeat(dashCount);
    const pct = Math.floor((count1 + count2) / total * 100).toString() + '%';
    if (lines.length < pct.length + 2) return pct + '>' + '.'.repeat(BAR_WIDTH - pct.length - 1);
    const bar = (lines.slice(0, lines.length - pct.length - 2) + pct + lines[lines.length - 2]).substring(0, BAR_WIDTH - 1) + '>';
    return bar + '.'.repeat(BAR_WIDTH - bar.length);
}


/**
 * A multipart file uploader. This can be used for large files.
 * (Batch allows up to 4mb, PUT allows up to 250mb, multipart is unlimited).
 * The way multipart upload works is chunks up to 60mb get uploaded, and they
 * must come in order one after the other. The sweet spot is apparently 10mb.
 */
export async function multipartUpload(log: (count: number, total: number) => void, name: string, data: string): Promise<void> {
    const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB chunks (must be multiple of 320 KiB, which this is)
    const bytes = new TextEncoder().encode(data);

    const r = await authFetch(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/${name}:/createUploadSession`, {
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
    if (!r.ok) throw new FetchError(r, await r.text());
    log(0, bytes.length);

    const uploadUrl = (await r.json()).uploadUrl;
    for (let start = 0; start < bytes.length; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE, bytes.length); // exclusive
        const r = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Length': String(end - start),
                'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}`
            },
            body: bytes.slice(start, end)
        });
        if (!r.ok) throw new FetchError(r, await r.text());
        log(end, bytes.length);
    }
}

export function escapeHtml(unsafe: string): string {
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
export async function exchangeCodeForToken(CLIENT_ID: string, code: string, code_verifier: string): Promise<{ accessToken: string, refreshToken: string } | FetchError> {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        code,
        code_verifier,
        redirect_uri: window.location.origin + window.location.pathname,
        grant_type: 'authorization_code'
    });
    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });
    if (!response.ok) return new FetchError(response, await response.text());

    const tokenData = await response.json();
    return { accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token };
}

/**
 * A simple signal object
 */
class AuthRefreshSignal {
    public willSomeoneSignal = false;
    private waiting: (() => void)[] = [];

    /**
     * Waits until someone signals. Should only be called if willSomeoneSignal is true.
     */
    public wait(): Promise<void> {
        return new Promise(resolve => this.waiting.push(resolve));
    }

    /**
     * Causes all waiting promises to resolve. Should only be called if you had earlier
     * set willSomeoneSignal to true (because it's you who is going to signal).
     */
    public signal(): void {
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
export async function authFetch(url: string, options?: RequestInit): Promise<Response> {
    function f(): Promise<Response> {
        const accessToken = localStorage.getItem('access_token');
        if (!accessToken) return Promise.resolve(new Response('Unauthorized: no access_token', { status: 401, statusText: 'Unauthorized' }));
        options = options ? { ...options } : {};
        options.headers = new Headers(options.headers);
        options.headers.set('Authorization', `Bearer ${accessToken}`);
        return fetch(url, options);
    }

    const CLIENT_ID = localStorage.getItem('client_id');
    if (!CLIENT_ID) return Promise.resolve(new Response('Bad request: no client_id', { status: 400, statusText: 'Bad Request' }));
    if (AUTH_REFRESH_SIGNAL.willSomeoneSignal) await AUTH_REFRESH_SIGNAL.wait();
    const r = await f();
    if (r.status !== 401) return r;

    // 401 Unauthorized.
    if (AUTH_REFRESH_SIGNAL.willSomeoneSignal) {
        await AUTH_REFRESH_SIGNAL.wait();  // wait until they finished their refresh
        return f();
    }
    // We'll do the refresh
    AUTH_REFRESH_SIGNAL.willSomeoneSignal = true;
    try {
        const refreshToken = localStorage.getItem('refresh_token');
        if (!refreshToken) return Promise.resolve(new Response('Unauthorized: no refresh_token', { status: 401, statusText: 'Unauthorized' }));
        const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
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
    } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 503, statusText: 'Service Unavailable' });
    } finally {
        AUTH_REFRESH_SIGNAL.signal();
    }
    return f();
}
