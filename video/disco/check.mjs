// Stap 3 van de Discobingo-video: nakijken. Haalt per scène een beeld uit het EINDBESTAND (niet uit de
// tussenframes), print de ondertitel van dat moment, geeft de scènelijst met begintijden en zoekt naar
// stilstaande of zwarte stukken. Eigen tijdstippen erbij: node video/disco/check.mjs 17.5 44
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TMP, OUT_FILE, FFMPEG } from './config.mjs';
import { ffmpeg } from '../lib.mjs';
import { SCENES } from './scenes.js';

/** Dezelfde montagelijst als stage.js: opnametijd -> videotijd. */
export function timeline(ev) {
  const rec = ev.edit.filter((e) => e.r0 != null);
  let o = 0;
  const segs = ev.edit.map((e) => {
    const len = e.r0 == null ? e.dur : ((rec[rec.indexOf(e) + 1]?.r0 ?? ev.duration) - e.r0) / e.speed;
    const s = { ...e, o0: o, o1: o + len }; o += len; return s;
  });
  const scenes = [];
  for (const s of segs) { const l = scenes.at(-1); if (l && l.id === s.id) l.o1 = s.o1; else scenes.push({ id: s.id, o0: s.o0, o1: s.o1 }); }
  return { segs, scenes, duration: o };
}

export function check(extra = []) {
  const bin = FFMPEG.replace(/ffmpeg$/, 'ffprobe');
  console.log(execFileSync(bin, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,pix_fmt,r_frame_rate,nb_frames:format=duration,size', '-of', 'default=nw=1', OUT_FILE], { encoding: 'utf8' }).trim());
  const ev = JSON.parse(readFileSync(join(TMP, 'events.json'), 'utf8'));
  const { scenes, duration } = timeline(ev);
  const dir = process.env.TT_STILLS || join(TMP, 'check');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const times = scenes.flatMap((s) => {
    const len = s.o1 - s.o0;
    return len > 7 ? [s.o0 + len * 0.15, s.o0 + len * 0.5, s.o0 + len * 0.9] : [s.o0 + len * 0.6];
  }).map((t) => ({ t, id: [...scenes].reverse().find((s) => s.o0 <= t)?.id }))
    .concat(extra.map((t) => ({ t, id: [...scenes].reverse().find((s) => s.o0 <= t)?.id })));
  times.sort((a, b) => a.t - b.t);
  for (const { t, id } of times) {
    const file = join(dir, `${t.toFixed(2).padStart(6, '0')}-${id}.png`);
    ffmpeg(['-ss', t.toFixed(3), '-i', OUT_FILE, '-frames:v', '1', file]);
    const sc = SCENES.find((s) => s.id === id);
    console.log(`${t.toFixed(2).padStart(6)} s  ${id.padEnd(7)} ${file}${sc?.title ? `\n          ${sc.title} | ${sc.caption}` : ''}`);
  }
  console.log('\nscènes (begintijd, duur):');
  for (const s of scenes) console.log(`  ${s.o0.toFixed(1).padStart(5)} s  ${(s.o1 - s.o0).toFixed(1).padStart(5)} s  ${s.id}`);
  console.log(`einde ${duration.toFixed(1)} s`);
  // elke ondertitel moet minstens 3,5 s te lezen zijn
  const short = scenes.filter((s) => SCENES.find((x) => x.id === s.id)?.caption && s.o1 - s.o0 < 3.5);
  console.log('ondertitels korter dan 3,5 s:', short.map((s) => `${s.id} (${(s.o1 - s.o0).toFixed(1)} s)`).join(', ') || 'geen');
  // stilstaande en zwarte stukken (ffmpeg meldt ze op stderr)
  const detect = (vf) => spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', OUT_FILE, '-vf', vf, '-an', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
  const freeze = detect('freezedetect=n=-60dB:d=2.5');
  const black = detect('blackdetect=d=0.2:pix_th=0.05');
  console.log('stilstaand (>= 2,5 s):', (freeze.match(/freeze_(start|duration): [\d.]+/g) || []).join(' ') || 'geen');
  console.log('zwart:', (black.match(/black_start:[\d.]+ black_end:[\d.]+/g) || []).join(' ') || 'geen');
}

if (import.meta.url === `file://${process.argv[1]}`) check(process.argv.slice(2).map(Number).filter(Number.isFinite));
