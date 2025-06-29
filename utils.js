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
export function setCookie(name, value) {
    const expires = new Date();
    expires.setTime(expires.getTime() + (7 * 24 * 60 * 60 * 1000)); // 7 days
    document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires.toUTCString()};path=/;SameSite=Strict`;
}
/**
 * Gets a cookie value by name
 * @param name - The cookie name to retrieve
 * @returns The cookie value as a string, or null if not found
 */
export function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ')
            c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0)
            return decodeURIComponent(c.substring(nameEQ.length, c.length));
    }
    return null;
}
/**
 * Deletes a cookie by setting its expiry to a past date
 * @param name - The cookie name to delete
 *
 * SIDE EFFECTS: Deletes the specified cookie
 */
export function deleteCookie(name) {
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;`;
}
/**
 * Fetches a blob from a URL, and returns that blob as a data url.
 * This calls just `fetch(url)` with no ability to pass extra headers.
 */
export async function fetchAsDataUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${await response.text()}`);
    }
    const blob = await response.blob();
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}
//# sourceMappingURL=utils.js.map