/**
 * Cookie utility functions
 */

/**
 * Sets a cookie with the given name and value
 * @param name - The cookie name
 * @param value - The cookie value (must be a string)
 * 
 * SIDE EFFECTS: Sets a cookie with 7-day expiry
 */
export function setCookie(name: string, value: string): void {
    const expires = new Date();
    expires.setTime(expires.getTime() + (7 * 24 * 60 * 60 * 1000)); // 7 days
    document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires.toUTCString()};path=/;SameSite=Strict`;
}

/**
 * Gets a cookie value by name
 * @param name - The cookie name to retrieve
 * @returns The cookie value as a string, or null if not found
 */
export function getCookie(name: string): string | null {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length));
    }
    return null;
}

/**
 * Deletes a cookie by setting its expiry to a past date
 * @param name - The cookie name to delete
 * 
 * SIDE EFFECTS: Deletes the specified cookie
 */
export function deleteCookie(name: string): void {
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;`;
}

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
            r.body = JSON.parse(atob(r.body));
        }
    }
    await Promise.all(promises);
    return response;
}