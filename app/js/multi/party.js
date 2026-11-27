// "Samen spelen": the party extras shared by the room server, the views and the screens.
// Pure, no DOM. Avatars and reactions are in every game; the awards ("Prijsuitreiking")
// belong to Discobingo (the statistics behind them are kept in game.js).

/**
 * The avatars a player can pick: party, music and animal emoji. Single code points only
 * (no flags, no skin tones, no ZWJ sequences, nothing newer than Unicode 11), so every
 * phone and tv shows them the same way.
 */
export const AVATARS = Object.freeze([
  '🎉', '🎊', '🎈', '🥳', '🎤', '🎧', '🎸', '🎹', '🥁', '🎺',
  '🎷', '🎻', '🎵', '🎶', '📻', '💿', '🦄', '🐱', '🐶', '🦊',
  '🐼', '🐨', '🐯', '🦁', '🐸', '🐧', '🦉', '🐙', '🦋', '🐢',
]);

export const isAvatar = (a) => typeof a === 'string' && AVATARS.includes(a);

/** A stable avatar for a player id (the same on every device and after every reload). */
export function avatarFor(id) {
  let h = 2166136261;
  for (const ch of String(id ?? '')) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return AVATARS[h % AVATARS.length];
}

/** The avatar to show for a seat: its own when valid (a stored room may hold none or a forged one), else the derived one. */
export const avatarOf = (p) => (p && isAvatar(p.avatar) ? p.avatar : avatarFor(p?.id));

/** The reactions a player can send (they float up over the big screen). */
export const REACTIONS = Object.freeze(['👏', '🔥', '😂', '😮', '🙌', '🎉']);
export const isReaction = (e) => typeof e === 'string' && REACTIONS.includes(e);
/** One reaction per player per this many ms. */
export const REACT_GAP_MS = 1500;
/** At most this many reactions per room per REACT_ROOM_WINDOW_MS (a burst cap for the tv). */
export const REACT_ROOM_MAX = 8;
export const REACT_ROOM_WINDOW_MS = 2000;

/* ---------- Discobingo: jokers and awards ---------- */

/** A joker for every streak of 3, 6, 9 ... right answers; at most this many in hand. */
export const JOKER_EVERY = 3;
export const JOKER_CAP = 2;
/** A streak shows from this length on ("🔥2"). */
export const STREAK_SHOWN = 2;

/** Statistics of one player over a Discobingo game (missing = a room stored before they existed). */
export const STAT_KEYS = ['answers', 'right', 'doubts', 'fastest', 'best', 'jokersUsed'];
export const freshStats = () => Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));
export function cleanStats(s) {
  const o = freshStats();
  if (s && typeof s === 'object') for (const k of STAT_KEYS) { const n = Number(s[k]); if (Number.isInteger(n) && n > 0) o[k] = Math.min(n, 100000); }
  return o;
}

/** Scherpschutter: at least this many answers, and at least this share right. */
export const SHARP_MIN_ANSWERS = 3;
export const SHARP_MIN_SHARE = 0.5;
/** Net niet: a player who did not win, at most this many squares from the goal. */
export const CLOSE_MAX_TO_GO = 2;
/** Langste reeks: at least this long. */
export const STREAK_MIN_AWARD = 2;

export const AWARD_KINDS = ['fastest', 'streak', 'doubts', 'sharp', 'close'];
const AWARD_INFO = {
  fastest: { emoji: '⚡', title: 'Snelste vingers' },
  streak: { emoji: '🔥', title: 'Langste reeks' },
  doubts: { emoji: '🤔', title: 'Twijfelkoning(in)' },
  sharp: { emoji: '🎯', title: 'Scherpschutter' },
  close: { emoji: '😅', title: 'Net niet' },
};

const times = (n, one, more) => `${n} ${n === 1 ? one : more}`;

/**
 * The awards of a finished Discobingo game, in the order of the ceremony. `players`: in room
 * order, each { id, name, avatar, stats, winner, toGo }. Each award has a measure; its holders
 * are everybody with the best value (ties share), and an award whose best value does not meet
 * its minimum is left out. Every award measures something else, and each appears at most once.
 * Pure and deterministic: the same players give the same awards, holders in room order.
 * Returns [{ kind, emoji, title, text, value, holders: [{ id, name, avatar }] }].
 */
export function discoAwards(players) {
  const list = (players || []).filter((p) => p && typeof p.id === 'string').map((p) => ({ ...p, stats: cleanStats(p.stats) }));
  const out = [];
  const award = (kind, value, ok, holders, text) => {
    if (!ok || !holders.length) return;
    out.push({ kind, ...AWARD_INFO[kind], text, value, holders: holders.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar })) });
  };
  const best = (fn, pool = list) => {
    if (!pool.length) return { value: null, holders: [] };
    const value = Math.max(...pool.map(fn));
    return { value, holders: pool.filter((p) => fn(p) === value) };
  };
  const f = best((p) => p.stats.fastest);
  award('fastest', f.value, f.value >= 1, f.holders, `${times(f.value, 'keer', 'keer')} als eerste goed`);
  const s = best((p) => p.stats.best);
  award('streak', s.value, s.value >= STREAK_MIN_AWARD, s.holders, `${s.value} op rij goed`);
  const d = best((p) => p.stats.doubts);
  award('doubts', d.value, d.value >= 1, d.holders, `${times(d.value, 'twijfelgeval', 'twijfelgevallen')} voor de spelleider`);
  const pool = list.filter((p) => p.stats.answers >= SHARP_MIN_ANSWERS);
  // compare shares as exact fractions (right * other.answers), never as rounded floats
  let sharp = [];
  for (const p of pool) {
    if (!sharp.length) { sharp = [p]; continue; }
    const q = sharp[0];
    const cmp = p.stats.right * q.stats.answers - q.stats.right * p.stats.answers;
    if (cmp > 0) sharp = [p];
    else if (cmp === 0) sharp.push(p);
  }
  const share = sharp.length ? sharp[0].stats.right / sharp[0].stats.answers : 0;
  award('sharp', Math.round(share * 100), sharp.length && share >= SHARP_MIN_SHARE, sharp,
    sharp.length ? `${sharp[0].stats.right} van de ${sharp[0].stats.answers} goed` : '');
  const losers = list.filter((p) => !p.winner && Number.isInteger(p.toGo) && p.toGo > 0);
  const c = best((p) => -p.toGo, losers);
  const toGo = c.value == null ? null : -c.value;
  award('close', toGo, toGo != null && toGo <= CLOSE_MAX_TO_GO, c.holders, toGo == null ? '' : `nog ${times(toGo, 'vakje', 'vakjes')} te gaan`);
  return out;
}
