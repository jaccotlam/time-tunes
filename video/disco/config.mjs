// Instellingen voor de Discobingo-uitlegvideo (alles wat je per opname wilt aanpassen).
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ROOT, PUBLIC_URL, FPS, VIDEO, FFMPEG } from '../config.mjs';

export { ROOT, PUBLIC_URL, FPS, VIDEO, FFMPEG };
export const DISCO_DIR = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
/** Tussenbestanden (frames, events.json). Nooit in de repo. */
export const TMP = process.env.TT_VIDEO_TMP ? join(process.env.TT_VIDEO_TMP, 'disco') : join(tmpdir(), 'timetunesr-video', 'disco');
export const OUT_FILE = join(ROOT, 'video', 'discobingo-uitleg.mp4');

/** De spelleider is een laptop/tv (brede opmaak), opgenomen op 0,75x: 960 x 540 videopixels. */
export const TV = { width: 1280, height: 720, scale: 0.75 };
/** Telefoons: 390 x 850 CSS-px, opgenomen op 0,9x: 351 x 765 videopixels (1 op 1 in beeld). */
export const PHONE = { width: 390, height: 850, scale: 0.9 };

export const PLAYERS = ['Anouk', 'Bram'];
/**
 * Vaste zaaiwaarde van de kamer (timetunesr.multiSeed.v1): bepaalt kaarten, nummers en de volgorde van de
 * categorieën. Met deze waarde (zie plan.mjs) is ronde 1 Artiest (Rick Astley), daarna Jaartal, Titel en Decennium,
 * en heeft Anouk een lijn door de ster met alle vier de kleuren: ze wint in ronde 4. De opname controleert dat.
 */
export const SEED = 80;
/** De antwoorden per ronde. 'typo' en 'deel' worden bij de opname gecontroleerd met match.js van de app. */
export const SCRIPT = {
  r1: { anouk: 'Rick Astly', bram: 'Astley' }, //  typfout = goed, alleen de achternaam = twijfel
  r2: { anouk: '2014', bram: '2020' }, //            Timberlake 2016: 2 ernaast is goed, 4 ernaast fout
  r3: { anouk: 'Final Countdwon' }, //               typfout = goed; Bram: weet ik niet
  r4: { anouk: 1980, bram: 1990 }, //                Diana Ross 1980
};
