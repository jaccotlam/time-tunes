// Instellingen voor de uitlegvideo. Alles wat je per opname wilt aanpassen staat hier.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const VIDEO_DIR = join(ROOT, 'video');
export const STAGE_DIR = join(VIDEO_DIR, 'stage');
/** Tussenbestanden (frames, camerafilmpjes, events.json). Nooit in de repo. */
export const TMP = process.env.TT_VIDEO_TMP || join(tmpdir(), 'timetunesr-video');
export const OUT_FILE = join(VIDEO_DIR, 'timetunesr-uitleg.mp4');
export const FFMPEG = process.env.FFMPEG || '/usr/bin/ffmpeg';

/** Adres dat in de QR-codes en op het printscherm staat (waar de app gehost wordt). */
export const PUBLIC_URL = process.env.TT_PUBLIC_URL || 'https://jaccotlam.github.io/time-tunes/';

export const FPS = 30;
export const VIDEO = { width: 1920, height: 1080 };
/** Telefoonscherm: 390 x 850 CSS-px, opgenomen op 1.1x = 429 x 935 videopixels (1:1 in beeld). */
export const PHONE = { width: 390, height: 850, scale: 1.1 };
/** De drie telefoons van "Ieder een eigen telefoon" staan naast elkaar: 0.9x = 351 x 765 videopixels. */
export const SMALL_PHONE = { width: 390, height: 850, scale: 0.9 };

/** Kaarten voor Tijdlijn met kaartjes (id's uit app/data/deck.json). */
export const TABLE = {
  timeline: ['025', '040', '073'], // ligt al open op tafel: 1975, 1991, 2013
  good: '037', //  1987: wordt tussen 1975 en 1991 gelegd -> goed
  bad: '032', //   2008: wordt achter 2013 gelegd -> fout
  // de tien kaarten van de winnende tijdlijn (alleen als plaatje op tafel)
  winner: ['085', '042', '025', '015', '037', '040', '005', '076', '073', '125'],
};

/** Tijdlijn, alleen de app. */
export const DIGITAL = {
  names: ['Sanne', 'Daan'],
  // Bekende nummers; de opname zoekt een schudvolgorde waarbij de startkaarten en de eerste beurt hieruit komen.
  known: ['001', '005', '009', '012', '015', '017', '020', '033', '036', '043', '045', '053', '062', '066', '081',
    '086', '087', '090', '094', '106', '107', '110', '115', '124', '133', '145', '146', '147', '149', '153'],
};

/**
 * Bingo, alleen de app. De app deelt met een vaste zaaiwaarde (timetunesr.bingoSeed.v1) altijd
 * dezelfde kaarten en nummers uit. Met deze waarde heeft Sanne bovenaan de rij
 * Jaren 80 | Vóór 2000 | Jaren 90 en is het eerste nummer uit 1986. De opname controleert dat.
 */
export const BINGO = {
  names: DIGITAL.names,
  size: 3,
  seed: 7402,
  first: { key: 'd80' }, // beurt 1 (Sanne): claimt "Jaren 80" -> goed, afgestempeld
  // Sprong in de tijd ("Even later…"): Sanne mist nog één vakje voor een volle rij.
  nearWin: {
    round: 4,
    sanne: { d90: '081' }, //            al afgestempeld naast "Jaren 80": Jaren 90 (1996)
    daan: { d80: '106', d00: '045' }, // Daan heeft er ook twee (1984 en 2007)
    card: '146', //                      het nummer van de winnende beurt (1977)
    claim: 'pre00', //                   ... waarmee Sanne "Vóór 2000" claimt: bingo
  },
};

/** Printscherm: zaaiwaarde van de bingokaarten (dezelfde kaarten op de telefoon en in het decor). */
export const PRINT_BINGO = { seed: 20261114, size: 4 };

/**
 * Ieder een eigen telefoon: een spelleider en twee spelers, elk in een eigen browsercontext,
 * echt met elkaar verbonden via een lokale PeerJS-server (zie tests/e2e/multi-helpers.mjs).
 */
export const MULTI = {
  host: 'Spelleider',
  names: ['Anouk', 'Bram'],
  seed: 7, //     timetunesr.multiSeed.v1: vaste kaarten en nummers
  size: 3,
  // De kamercode is in de app willekeurig. De opname kiest er een met smalle letters: bij brede
  // letters (M, W) duwt de code in de lobby de QR-code buiten beeld (bug in de app, zie README).
  code: 'KJRT',
};

/** Eigen playlist: deze staat al klaar; in de video komt er één nummer bij via zoeken. */
export const PLAYLIST = {
  id: 'demo',
  name: 'Feestje',
  tracks: [
    { n: 1, itunesId: 1440763833, title: 'Gold Digger', artist: 'Kanye West', year: 2005 },
    { n: 2, itunesId: 1308586364, title: 'Back for Good', artist: 'Take That', year: 1995 },
    { n: 3, itunesId: 1322068804, title: 'Mambo No. 5 (A Little Bit Of...)', artist: 'Lou Bega', year: 1999 },
    { n: 4, itunesId: 268284600, title: '...Baby One More Time', artist: 'Britney Spears', year: 1998 },
    { n: 5, itunesId: 1440741632, title: 'In the Summertime', artist: 'Mungo Jerry', year: 1970 },
  ],
  query: 'dancing queen', //                    wat er in het zoekveld wordt getypt
  expect: { title: 'Dancing Queen', artist: 'ABBA', year: 1976 }, // het eerste zoekresultaat moet dit zijn
};
