// "Links": the owner's word for one Spotify app (one Client ID). A Spotify app in Development
// Mode only lets in the accounts its owner put on that app's user list (User Management), at
// most 5, so a host who wants more guests to log in makes several apps and adds the people
// himself: "link 1" for the family, "link 2" for the friends. Pure, no DOM, no storage: shared
// by the app (spotify.js, settings, the mix panel), the room server (server/room.mjs: the
// links in the room meta) and the account server (server/accounts.mjs: the account's list).
// A Client ID is a public identifier, never a secret; a client secret is never asked for.

/** Most links one host may set up (one Spotify developer account may hold more apps; 10 is plenty for a party). */
export const LINKS_MAX = 10;
/** Most characters of a link's short name ("familie", "vrienden"). */
export const LINK_NAME_MAX = 20;
/** People Spotify lets in per app in Development Mode (the owner adds them himself). */
export const LINK_USERS_MAX = 5;

const CLIENT_ID = /^[0-9a-f]{32}$/i;
// zero-width, soft hyphen, invisible operators and bidi control characters: a name shown on
// other phones must look like what it is
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** A link's short name as plain one-line text of at most LINK_NAME_MAX characters ('' = none). */
export function cleanLinkName(v) {
  if (typeof v !== 'string') return '';
  const flat = v.slice(0, LINK_NAME_MAX * 8).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(INVISIBLE, '')
    .replace(/\s+/g, ' ').trim();
  // cut by code point (Array.from), so an emoji at the end is never split into half a surrogate pair;
  // a lone surrogate (half a pair in the input) goes
  return Array.from(flat).filter((c) => !/^[\ud800-\udfff]$/.test(c)).slice(0, LINK_NAME_MAX).join('').trim();
}

/** A Client ID in its stored form (lower case), or null when it is not one. */
export const cleanLinkId = (v) => (typeof v === 'string' && CLIENT_ID.test(v.trim()) ? v.trim().toLowerCase() : null);

const own = (o, k) => (o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/**
 * A list of links as [{ id, name }]: only valid Client IDs (lower case), every id once (the
 * first one wins), names cleaned, at most LINKS_MAX. Anything else in the input is dropped
 * (never an error: an old phone or a hostile message simply gets fewer links).
 */
export function cleanLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const l of raw.slice(0, LINKS_MAX * 4)) {
    if (!l || typeof l !== 'object' || Array.isArray(l)) continue;
    const id = cleanLinkId(own(l, 'id'));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: cleanLinkName(own(l, 'name')) });
    if (out.length >= LINKS_MAX) break;
  }
  return out;
}

/** "Link 2 · vrienden" (i: 0-based). */
export const linkLabel = (i, name = '') => `Link ${Number(i) + 1}${name ? ` · ${name}` : ''}`;

/** Same lists (ids, names and order)? */
export const sameLinks = (a, b) => JSON.stringify(cleanLinks(a)) === JSON.stringify(cleanLinks(b));

/**
 * Was this Spotify error the answer for an account that is NOT on the user list of the app
 * it logged in with? Spotify lets such a person finish the login and then answers the Web
 * API with 403 ("User not registered in the Developer Dashboard" or similar; the exact text
 * is not documented). Tolerant on purpose: a 403 on the first call after the login (GET /me,
 * which needs no scope) counts whatever its text, unless it says Premium (playback without
 * Premium, or an app owner without Premium: other problems with their own message). A 403
 * that names a missing scope is not this either. With `anyForbidden` every other 403 counts
 * (the guest's own read calls in a room, see below). Takes a SpotifyError ({ code, status,
 * detail: { where, status, reason, message } }) or that detail itself.
 */
export function notRegistered(e, { anyForbidden = false } = {}) {
  if (!e || typeof e !== 'object') return false;
  if (e.code === 'not-allowed') return true;
  // a TopError / PlaylistError ('scope') made from the SpotifyError: decide by what Spotify said
  if (e.cause && typeof e.cause === 'object' && e.cause !== e) return notRegistered(e.cause, { anyForbidden });
  const d = e.detail && typeof e.detail === 'object' ? e.detail : e;
  const status = Number(d.status ?? e.status);
  if (status !== 403) return false;
  const text = `${d.reason || ''} ${d.message || ''}`;
  if (/premium/i.test(text)) return false;
  if (/scope/i.test(text)) return false;
  if (/regist|developer|dashboard|user management|allow ?list|whitelist|not.{0,20}allow/i.test(text)) return true;
  // anyForbidden: a read call of the guest's own part (top songs, own playlists) right after a
  // login that asked for exactly those scopes: Spotify may answer /me with 200 and only these
  // with 403; nothing else forbids them
  if (anyForbidden) return true;
  return /(^|\s)GET \/me$/.test(String(d.where || '')) || String(d.where || '') === '/me';
}

/**
 * How many phones logged in through each link: use = { memberId: clientId }, only members in
 * `members` (a Set or array of ids) count. Returns [n per link], in the order of `links`.
 */
export function linkCounts(links, use, members = null) {
  const list = cleanLinks(links);
  const ok = members == null ? null : new Set(members);
  const n = list.map(() => 0);
  for (const [mid, id] of Object.entries(use && typeof use === 'object' ? use : {})) {
    if (ok && !ok.has(mid)) continue;
    const i = list.findIndex((l) => l.id === id);
    if (i >= 0) n[i]++;
  }
  return n;
}
