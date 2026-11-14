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

/** Kaarten voor het verhaal met fysieke kaarten (id's uit app/data/deck.json). */
export const TABLE = {
  timeline: ['025', '040', '073'], // ligt al open op tafel: 1975, 1991, 2013
  good: '037', //  1987: wordt tussen 1975 en 1991 gelegd -> goed
  bad: '032', //   2008: wordt achter 2013 gelegd -> fout
  // de tien kaarten van de winnende tijdlijn (alleen als plaatje op tafel)
  winner: ['085', '042', '025', '015', '037', '040', '005', '076', '073', '125'],
};

/** Digitale modus. */
export const DIGITAL = {
  names: ['Sanne', 'Daan'],
  // Bekende nummers; de opname zoekt een schudvolgorde waarbij de eerste vier kaarten hieruit komen.
  known: ['001', '005', '009', '012', '015', '017', '020', '033', '036', '043', '045', '053', '062', '066', '081',
    '086', '087', '090', '094', '106', '107', '110', '115', '124', '133', '145', '146', '147', '149', '153'],
  // Na de foute beurt springt de video naar het einde van het potje (winnaarsscherm). Uitzetten kan.
  showWinner: true,
  // Bijna-gewonnen stand voor de slotbeurt (Sanne heeft 9 kaarten, de 10e ligt klaar).
  nearWin: {
    sanne: ['131', '009', '146', '017', '012', '081', '135', '032', '075'],
    daan: ['034', '043', '053', '122', '097', '151'],
    card: '025', // 1975: hoort tussen 1965 en 1977
    round: 12,
  },
};
