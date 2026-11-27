// Pure helpers for the music screens (the "Muziek kiezen" hub, the playlist sheet, the edit
// screen's status header): words for counts and progress, the pick mode ("you choose music for
// room ABCD") and how a pasted link is recognised. No DOM here, so tests/unit can pin it.
import { MIN_TRACKS, validYear, rateEta } from '../playlist-logic.js';

const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;
export { plural };

/**
 * Seconds per checked year as a FIRST guess only (MusicBrainz: one request per 1.1 s, and a
 * song MusicBrainz does not know by ISRC needs a second one, a search). Screens that wait show
 * the observed rate: yearsWaitText().
 */
export const SECONDS_PER_YEAR = 2.2;

/* ---------- pick mode: the hub opened from a room lobby ---------- */

/** sessionStorage: { kind: 'room', code, back, at } while the hub chooses music for a room. */
export const PICK_KEY = 'timetunesr.musicPick.v1';
/** sessionStorage: the room code the hub just chose music for (the lobby reads it once). */
export const PICKED_KEY = 'timetunesr.musicPicked.v1';
/** A pick older than this is stale (the room lobby was left another way). */
export const PICK_MAX_AGE_MS = 60 * 60 * 1000;

/** A valid pick mode, or null. `back` is always one of our own hashes. */
export function cleanPick(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.kind !== 'room' || typeof raw.code !== 'string' || !/^[A-Z]{4}$/.test(raw.code)) return null;
  if (raw.back !== '#/spelleider') return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at > now + 60_000 || now - at > PICK_MAX_AGE_MS) return null;
  return { kind: 'room', code: raw.code, back: raw.back, at };
}

function ss() {
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

export function readPick(storage = ss(), now = Date.now()) {
  if (!storage) return null;
  let raw = null;
  try { raw = JSON.parse(storage.getItem(PICK_KEY) || 'null'); } catch { raw = null; }
  return cleanPick(raw, now);
}

export function setPick(pick, storage = ss()) {
  const p = cleanPick({ ...pick, at: Date.now() });
  if (!p || !storage) return null;
  try { storage.setItem(PICK_KEY, JSON.stringify(p)); } catch { return null; }
  return p;
}

export function clearPick(storage = ss()) {
  try { storage?.removeItem(PICK_KEY); } catch { /* ignore */ }
}

/** The hub chose music for this room: the lobby says so once. */
export function markPicked(code, storage = ss()) {
  try { storage?.setItem(PICKED_KEY, String(code || '')); } catch { /* ignore */ }
}
export function takePicked(storage = ss()) {
  let v = null;
  try { v = storage?.getItem(PICKED_KEY) || null; storage?.removeItem(PICKED_KEY); } catch { v = null; }
  return v && /^[A-Z]{4}$/.test(v) ? v : null;
}

/* ---------- search input ---------- */

/**
 * Is this a pasted Deezer playlist link (not a search for "538" or "Top 40")? A bare number only
 * counts when it is long enough to be a playlist id (Deezer's are 7+ digits).
 */
export function isPlaylistLink(input) {
  const s = String(input ?? '').trim();
  if (/deezer\.com\/|^deezer:\/\//i.test(s)) return true;
  return /^\d{7,16}$/.test(s);
}

/** "688 nummers · door Deezer Charts" (count or maker may be missing). */
export function countLine(count, by) {
  const parts = [];
  if (Number.isInteger(count) && count >= 0) parts.push(plural(count, 'nummer', 'nummers'));
  if (by) parts.push(`door ${by}`);
  return parts.join(' · ');
}

/** Only https images (validated again here: covers come from remote services). */
export const safeImage = (url) => (typeof url === 'string' && url.length < 1200 && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null);

/* ---------- waiting for checked years ---------- */

/** Rough seconds left until `min` years are checked. */
export function yearsEta(checked, min) {
  const left = Math.max(0, (Number(min) || 0) - (Number(checked) || 0));
  return Math.ceil(left * SECONDS_PER_YEAR);
}

/**
 * The line while years are checked: "nog ongeveer 40 seconden" from the rate observed so far
 * (rateEta in playlist-logic.js), or "MusicBrainz reageert traag…" when nothing came in for 10 s.
 */
export function yearsWaitText(o) {
  const e = rateEta(o);
  return e.stalled ? 'MusicBrainz reageert traag…' : etaText(e.sec);
}

/** "nog ongeveer 40 seconden" / "nog ongeveer 2 minuten" / "bijna klaar". */
export function etaText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s <= 5) return 'bijna klaar';
  if (s < 60) return `nog ongeveer ${Math.max(10, Math.round(s / 5) * 5)} seconden`;
  const m = Math.round(s / 60);
  return `nog ongeveer ${m} ${m === 1 ? 'minuut' : 'minuten'}`;
}

/* ---------- readiness of a playlist in words ---------- */

/**
 * While songs are held back for the year check: "Speelt met 33 van 120 nummers; van 87 andere
 * wordt het jaartal nog opgezocht of nagekeken." (held + no year yet; only what is true: a song
 * that cannot play for another reason is not in the 87). counts: deckCounts() of playlists.js.
 */
export function heldText(c) {
  const later = (c.held || 0) + (c.noYear || 0);
  const what = c.noYear ? 'opgezocht of nagekeken' : 'nagekeken';
  return `Speelt met ${c.inDeck} van ${c.total} nummers; van ${later} ${later === 1 ? 'ander nummer' : 'andere'} wordt het jaartal nog ${what}.`;
}

/**
 * One line about how this list plays now, plus what the user can do about it:
 * { text, tone: 'ok' | 'busy' | 'warn', action: null | 'connect' | 'wait' }.
 * counts: deckCounts() of playlists.js ({ total, playable, inDeck, held }) for the current music
 * source; spotifyPlayable: playable count when Spotify would be the source; status: enrich.status().
 */
export function readinessInfo({ counts, source, spotifyPlayable = 0, status = null, playNow = false, spotifyConnected = false } = {}) {
  const c = counts || { total: 0, playable: 0, inDeck: 0, held: 0 };
  const st = status || {};
  if (!c.total) return { text: 'Nog leeg: voeg nummers toe.', tone: 'warn', action: null };
  if (c.inDeck < MIN_TRACKS.timeline) {
    if (source !== 'spotify' && spotifyPlayable >= MIN_TRACKS.timeline) {
      const todo = (st.appleTodo || 0) + (st.appleDone || 0);
      // connected but playing fragments: the way out is choosing Spotify as the music source
      const how = spotifyConnected ? 'Kies Spotify als muziekbron' : 'Verbind Spotify';
      return {
        text: todo ? `Deze lijst speelt via Spotify. ${how}, of wacht op de fragmenten: ${st.appleDone || 0} van ${todo} gezocht.`
          : `Deze lijst speelt via Spotify. ${how} om hem te spelen.`,
        tone: 'warn', action: spotifyConnected ? 'source' : 'connect',
      };
    }
    if ((st.yearsMissing || 0) > 0 && (st.pending || 0) > 0) {
      return { text: `Jaartallen ophalen… ${st.ready || 0} van ${c.total}.`, tone: 'busy', action: 'wait' };
    }
    return { text: `Te weinig speelbare nummers (${c.inDeck}): Tijdlijn vraagt er ${MIN_TRACKS.timeline}, Bingo ${MIN_TRACKS.bingo}.`, tone: 'warn', action: null };
  }
  if (c.held > 0) return { text: heldText(c), tone: 'busy', action: null };
  if (playNow && (st.yearsPending || 0) > 0) {
    return { text: `Speelt met ${c.inDeck} van ${c.total} nummers; niet alle jaartallen zijn al nagekeken.`, tone: 'busy', action: null };
  }
  if (source === 'spotify') {
    return { text: c.inDeck === c.total ? `Klaar om te spelen via Spotify · ${plural(c.total, 'nummer', 'nummers')}.` : `Klaar om te spelen via Spotify: ${c.inDeck} van ${c.total} nummers.`, tone: 'ok', action: null };
  }
  return { text: c.inDeck === c.total ? `Klaar om te spelen met fragmenten · ${plural(c.total, 'nummer', 'nummers')}.` : `Speelt met fragmenten: ${c.inDeck} van ${c.total} nummers.`, tone: 'ok', action: null };
}

/**
 * The background work for a list in one short line ('' when nothing runs). source: the music
 * source of this phone; the Apple Music fragment search is only shown when fragments are the
 * source (with Spotify it is noise: Spotify plays the whole song).
 */
export function workLine(st, { short = false, source = 'preview' } = {}) {
  if (!st || !st.total) return '';
  if (st.yearsPending > 0 && (st.working || st.pending)) {
    const done = st.total - st.yearsPending;
    return short ? `jaren nakijken ${done}/${st.total}` : `Jaartallen nakijken… ${done} van ${st.total}`;
  }
  if (st.yearsMissing > 0 && st.pending > 0) return short ? `jaren ophalen ${st.ready}/${st.total}` : `Jaartallen ophalen… ${st.ready} van ${st.total}`;
  // Apple Music fragments only matter for songs without any fragment (a Deezer song has one)
  if (source !== 'spotify' && st.appleTodo > 0 && st.fragmentsMissing > 0 && (st.working || st.pending)) {
    const all = st.appleDone + st.appleTodo;
    return short ? `fragmenten ${st.appleDone}/${all}` : `Fragmenten zoeken… ${st.appleDone} van ${all}`;
  }
  return '';
}

/** Source mark of a stored list. */
export const sourceLabel = (p) => (p?.source?.kind === 'spotify' ? 'Spotify' : p?.source?.kind === 'deezer' ? 'Deezer' : 'eigen');

/**
 * The mark a row of the edit screen gets, or null: only where the player can do something.
 * 'missing' (no year: fill it in) or 'unsure' (a year that is not sure and no longer waits for the
 * background check; in a hand-made list also while it waits, as before).
 */
export function rowMark(t, { pending = false, fromSource = false } = {}) {
  if (!validYear(Number(t?.year))) return 'missing';
  if (t.yearSure === false && (!pending || !fromSource)) return 'unsure';
  return null;
}
