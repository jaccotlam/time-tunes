// OAuth 2.0 Authorization Code + PKCE helpers (RFC 7636) for the Spotify login.
// Pure functions (Web Crypto only), so they run in the browser and in node --test.

export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Cryptographically random string of `length` unreserved characters (43..128 for a verifier). */
export function randomString(length = 64) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  // 66 characters: accept bytes < 198 (= 3 * 66) so every character is equally likely
  const limit = UNRESERVED.length * Math.floor(256 / UNRESERVED.length);
  let out = '';
  let i = 0;
  while (out.length < length) {
    if (i >= bytes.length) { globalThis.crypto.getRandomValues(bytes); i = 0; }
    const b = bytes[i++];
    if (b < limit) out += UNRESERVED[b % UNRESERVED.length];
  }
  return out;
}

export function base64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** S256 code challenge: base64url(sha256(verifier)). */
export async function codeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
  return base64url(hash);
}

export function authorizeUrl({ clientId, redirectUri, state, challenge, scope }) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  if (scope) p.set('scope', scope);
  return `${AUTHORIZE_URL}?${p}`;
}

/** Body for the code -> token exchange. */
export function tokenRequestBody({ clientId, code, redirectUri, verifier }) {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  }).toString();
}

/** Body for refreshing an access token (public client: client_id, no secret). */
export function refreshRequestBody({ clientId, refreshToken }) {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  }).toString();
}

/**
 * Read Spotify's redirect from a query string ("?code=..&state=.." or "?error=..&state=..").
 * Returns null when the query is not an OAuth callback.
 */
export function parseCallback(search) {
  const p = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const state = p.get('state');
  const code = p.get('code');
  const error = p.get('error');
  if (!state || (!code && !error)) return null;
  return { code, state, error };
}

/** Redirect URI for this page: origin + path, without query or hash. */
export function redirectUriFor(href) {
  const u = new URL(href);
  return `${u.origin}${u.pathname}`;
}

/**
 * Spotify accepts https redirect URIs, and plain http only for loopback IP
 * addresses (127.0.0.1 / [::1]); "localhost" is refused.
 * Returns null when fine, else 'localhost' | 'insecure'.
 */
export function redirectProblem(href) {
  let u;
  try { u = new URL(href); } catch { return 'insecure'; }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return null;
  if (u.protocol === 'http:' && u.hostname === 'localhost') return 'localhost';
  return 'insecure';
}

/** Same page, but on 127.0.0.1 instead of localhost (for local testing). */
export function loopbackVersion(href) {
  const u = new URL(href);
  if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
  return u.toString();
}
