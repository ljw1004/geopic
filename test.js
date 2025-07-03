/**
 * OAuth2 Authorization Code Flow with PKCE Implementation
 *
 * This implementation provides:
 * 1. Authorization code flow with PKCE for SPAs
 * 2. Automatic token refresh using refresh tokens
 * 3. Secure token storage in localStorage
 *
 * INVARIANTS:
 * - PKCE verifier is cryptographically random and never exposed to the authorization server until code exchange
 * - Refresh tokens expire after 24 hours for SPAs
 * - Authorization codes can only be used once
 */
const CLIENT_ID = 'e5461ba2-5cd4-4a14-ac80-9be4c017b685';
const REDIRECT_URI = window.location.origin + window.location.pathname;
const TENANT_ID = 'common'; // Use 'common' for multi-tenant, or specific tenant ID
const SCOPES = 'files.readwrite offline_access'; // offline_access needed for refresh tokens
/**
 * Generates a cryptographically random string for PKCE
 * @param length The length of the random string
 * @returns Base64URL encoded random string
 */
function generateRandomString(length) {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return base64UrlEncode(array);
}
/**
 * Base64URL encode (without padding)
 */
function base64UrlEncode(buffer) {
    const base64 = btoa(String.fromCharCode(...buffer));
    return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}
/**
 * Generates PKCE challenge from verifier
 * @param verifier The PKCE verifier
 * @returns Base64URL encoded SHA256 hash of verifier
 */
async function generatePKCEChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(digest));
}
/**
 * Initiates OAuth2 authorization code flow with PKCE
 * Stores PKCE verifier in sessionStorage and redirects to Microsoft login
 */
export async function initiateCodeFlow() {
    // Generate PKCE verifier and challenge
    const codeVerifier = generateRandomString(128);
    const codeChallenge = await generatePKCEChallenge(codeVerifier);
    // Store verifier for later use
    sessionStorage.setItem('pkce_verifier', codeVerifier);
    // Build authorization URL
    const authUrl = new URL(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`);
    authUrl.searchParams.append('client_id', CLIENT_ID);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.append('response_mode', 'query');
    authUrl.searchParams.append('scope', SCOPES);
    authUrl.searchParams.append('code_challenge', codeChallenge);
    authUrl.searchParams.append('code_challenge_method', 'S256');
    // Redirect to authorization endpoint
    window.location.href = authUrl.toString();
}
/**
 * Handles OAuth2 callback and exchanges authorization code for tokens
 * Should be called on page load if authorization code is present in URL
 * @returns true if successfully handled callback, false otherwise
 */
export async function handleCodeFlowCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const error = urlParams.get('error');
    if (error) {
        console.error('OAuth error:', error, urlParams.get('error_description'));
        return false;
    }
    if (!code) {
        return false;
    }
    // Get PKCE verifier
    const codeVerifier = sessionStorage.getItem('pkce_verifier');
    if (!codeVerifier) {
        console.error('No PKCE verifier found');
        return false;
    }
    try {
        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(code, codeVerifier);
        // Store tokens
        storeTokens(tokens);
        // Clean up
        sessionStorage.removeItem('pkce_verifier');
        // Remove code from URL
        window.history.replaceState({}, document.title, window.location.pathname);
        console.log('Successfully authenticated with code flow');
        return true;
    }
    catch (error) {
        console.error('Failed to exchange code for tokens:', error);
        return false;
    }
}
/**
 * Exchanges authorization code for access and refresh tokens
 * @param code The authorization code
 * @param codeVerifier The PKCE verifier
 * @returns Token response
 */
async function exchangeCodeForTokens(code, codeVerifier) {
    const tokenUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append('client_id', CLIENT_ID);
    params.append('scope', SCOPES);
    params.append('code', code);
    params.append('redirect_uri', REDIRECT_URI);
    params.append('grant_type', 'authorization_code');
    params.append('code_verifier', codeVerifier);
    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token exchange failed: ${errorText}`);
    }
    return await response.json();
}
/**
 * Stores tokens in localStorage with expiration time
 * @param tokens The token response from OAuth2 server
 */
function storeTokens(tokens) {
    const tokenData = {
        access_token: tokens.access_token,
        expires_at: Date.now() + (tokens.expires_in * 1000),
    };
    if (tokens.refresh_token !== undefined) {
        tokenData.refresh_token = tokens.refresh_token;
    }
    localStorage.setItem('oauth_tokens', JSON.stringify(tokenData));
}
/**
 * Gets current access token, refreshing if necessary
 * @returns Valid access token or null if unable to obtain one
 */
export async function getAccessToken() {
    const storedData = localStorage.getItem('oauth_tokens');
    if (!storedData) {
        return null;
    }
    const tokenData = JSON.parse(storedData);
    // Check if token is still valid (with 5 minute buffer)
    if (Date.now() < tokenData.expires_at - 300000) {
        return tokenData.access_token;
    }
    // Token expired, try to refresh
    if (!tokenData.refresh_token) {
        console.log('No refresh token available');
        return null;
    }
    try {
        const tokens = await refreshAccessToken(tokenData.refresh_token);
        storeTokens(tokens);
        return tokens.access_token;
    }
    catch (error) {
        console.error('Failed to refresh token:', error);
        localStorage.removeItem('oauth_tokens');
        return null;
    }
}
/**
 * Refreshes access token using refresh token
 * @param refreshToken The refresh token
 * @returns New token response
 */
async function refreshAccessToken(refreshToken) {
    const tokenUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append('client_id', CLIENT_ID);
    params.append('scope', SCOPES);
    params.append('refresh_token', refreshToken);
    params.append('grant_type', 'refresh_token');
    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed: ${errorText}`);
    }
    return await response.json();
}
/**
 * Logs out by clearing stored tokens
 */
export function logout() {
    localStorage.removeItem('oauth_tokens');
    sessionStorage.removeItem('pkce_verifier');
}
/**
 * Test function to demonstrate usage
 */
export async function testCodeFlow() {
    // Check if we're handling a callback
    const handled = await handleCodeFlowCallback();
    if (handled) {
        // Successfully authenticated, try to get access token
        const token = await getAccessToken();
        if (token) {
            console.log('Got access token:', token.substring(0, 20) + '...');
            // Test API call
            const response = await fetch('https://graph.microsoft.com/v1.0/me/drive/special/photos', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            if (response.ok) {
                const data = await response.json();
                console.log('Photos folder:', data);
            }
            else {
                console.error('API call failed:', await response.text());
            }
        }
    }
    else {
        // Check if we have a valid token
        const token = await getAccessToken();
        if (token) {
            console.log('Already authenticated with valid token');
        }
        else {
            console.log('Not authenticated, initiate login with: initiateCodeFlow()');
        }
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
function progressBar(count1, count2, total) {
    const barWidth = 20;
    const equalsCount = Math.floor(count1 / total * barWidth);
    const dashCount = Math.floor((count1 + count2) / total * barWidth) - equalsCount;
    const emptyCount = barWidth - equalsCount - dashCount - 1;
    let bar = '='.repeat(equalsCount) + '-'.repeat(dashCount) + '>' + ' '.repeat(emptyCount);
    if (equalsCount + dashCount >= 5) {
        const pct = Math.floor((count1 + count2) / total * 100).toString().padStart(2, '0') + '%';
        const pos = equalsCount + dashCount - 4;
        bar = bar.substring(0, pos) + pct + bar.substring(pos + pct.length);
    }
    return bar;
}
export function testProgress() {
    console.log(progressBar(30, 0, 100));
    console.log(progressBar(20, 10, 100));
    console.log(progressBar(60, 30, 100));
}
//# sourceMappingURL=test.js.map