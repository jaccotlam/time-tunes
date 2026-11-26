// Draaiboek vooraf nagerekend met de spelregels van de app zelf (app/js/multi/*.js):
// met een vaste zaaiwaarde (timetunesr.multiSeed.v1) zijn kaarten, nummers en de volgorde van de
// categorieën voorspelbaar. Zoekt een zaaiwaarde waarmee de video in vier rondes een mooi verhaal vertelt:
//   ronde 1 is een getypte vraag (artiest of titel), alle vier de categorieën komen binnen vier rondes aan bod,
//   en Anouk heeft een lijn door de ster met alle vier de kleuren, zodat ze in ronde 4 bingo heeft.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.mjs';
import { createRoom, addPlayer, setSettings, startGame, reveal, nextRound } from '../../app/js/multi/game.js';
import { artistVerdict, titleVerdict } from '../../app/js/multi/match.js';
import { LINES, CENTER, decadeOf } from '../../app/js/multi/disco.js';

export const deck = JSON.parse(readFileSync(join(ROOT, 'app/data/deck.json'), 'utf8')).cards
  .map((c) => ({ ...c, id: String(c.id), year: Number(c.year) }));

/** Speel de eerste vier rondes na; geeft per ronde categorie en nummer, plus de kaart van Anouk. */
export function simulate(seed, names = ['Anouk', 'Bram']) {
  let r = createRoom({ code: 'ABCD', settings: { game: 'disco' } });
  names.forEach((n, i) => { r = addPlayer(r, { id: `p${i}`, name: n }); });
  r = startGame(r, { cards: deck, seed, now: 1000 });
  const rounds = [];
  for (let i = 0; i < 4; i++) {
    rounds.push({ cat: r.game.disco.cat, song: r.game.songs[r.game.current] });
    if (i < 3) r = nextRound(reveal(r), { now: 2000 + i });
  }
  return { rounds, cards: names.map((n, i) => r.game.per[`p${i}`].card) };
}

/** Een getypte antwoordvariant per soort: kleine typefout (goed), maar een deel van het antwoord (twijfel). */
export function typoOf(text, fn) {
  const tries = [text.replace(/e/, 'ee'), text.replace(/([a-z])\1/, '$1'), text.replace(/(?<=[a-z])([aeiou])(?=[a-z])/, ''), text.replace(/s/, 'ss'), text.replace(/c/, 'k')];
  return tries.find((t) => t !== text && fn(t, text).verdict === 'right') || null;
}
export function partOf(text, fn) {
  const words = text.replace(/^(The|De|Het) /i, '').split(/\s+/);
  const tries = [words[words.length - 1], words[0], words.slice(0, -1).join(' '), words.slice(1).join(' ')];
  return tries.find((t) => t && t !== text && fn(t, text).verdict === 'doubt') || null;
}
export const fnFor = (cat) => (cat === 'artist' ? artistVerdict : titleVerdict);
export const realFor = (cat, song) => (cat === 'artist' ? song.artist : song.title);

/** Een lijn door de ster met de vier categorieën precies één keer; geeft de vier vakjes per categorie. */
export function winLineOf(card) {
  for (const line of LINES) {
    if (!line.includes(CENTER)) continue;
    const cells = line.filter((i) => i !== CENTER);
    if (new Set(cells.map((i) => card[i])).size === 4) return Object.fromEntries(cells.map((i) => [card[i], i]));
  }
  return null;
}

export function findSeed(from = 1, to = 3000) {
  const out = [];
  for (let seed = from; seed <= to; seed++) {
    const sim = simulate(seed);
    const [r1] = sim.rounds;
    if (!['artist', 'title'].includes(r1.cat)) continue;
    const real = realFor(r1.cat, r1.song);
    if (!/^[A-Za-z' ]+$/.test(real) || real.length < 6 || real.split(' ').length < 2) continue;
    if (!typoOf(real, fnFor(r1.cat)) || !partOf(real, fnFor(r1.cat))) continue;
    const line = winLineOf(sim.cards[0]);
    if (!line) continue;
    out.push({ seed, sim, line });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const { seed, sim } of findSeed().slice(0, 15)) {
    console.log(seed, sim.rounds.map((x) => `${x.cat}: ${x.song.artist} - ${x.song.title} (${x.song.year})`).join(' | '));
  }
}
