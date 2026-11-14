// Room codes for "Samen spelen". Pure: shared by the browser and `npm test`.
//
// A code is 4 capital letters without look-alikes (no I, L, O: they read as 1 or 0),
// so it can be read aloud across the room and typed without doubt.

export const CODE_LENGTH = 4;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
/** Prefix of the host's peer id on the signalling server (keeps us apart from other apps). */
export const DEFAULT_PEER_PREFIX = 'timetunesr-kamer-';

/** A fresh random room code. */
export function makeCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return s;
}

/** A new code that differs from every code in `avoid` (e.g. codes that turned out to be taken). */
export function makeFreshCode(avoid = [], rand = Math.random) {
  const used = new Set(avoid);
  for (let i = 0; i < 200; i++) {
    const c = makeCode(rand);
    if (!used.has(c)) return c;
  }
  throw new Error('Geen vrije kamercode gevonden.');
}

export function isValidCode(code) {
  return typeof code === 'string' && code.length === CODE_LENGTH && [...code].every((ch) => CODE_ALPHABET.includes(ch));
}

/**
 * What somebody typed or scanned -> a valid code, or null.
 * Accepts "abcd", " AB CD ", "ab-cd" and a full join link ".../#/kamer/ABCD".
 */
export function normalizeCode(input) {
  if (input == null) return null;
  let s = String(input).trim();
  const m = s.match(/#\/kamer\/([A-Za-z]{4})\b/);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[\s\-_.]/g, '');
  return isValidCode(s) ? s : null;
}

/** Peer id of the host of a room on the signalling server. */
export function peerIdForCode(code, prefix = DEFAULT_PEER_PREFIX) {
  if (!isValidCode(code)) throw new Error('Ongeldige kamercode.');
  return `${prefix}${code}`;
}

/** Link that opens the join screen for this room (for the QR code). */
export function joinUrl(baseUrl, code) {
  return `${String(baseUrl || '').split('#')[0]}#/kamer/${code}`;
}
