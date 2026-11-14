// Stap 4: nakijken. Haalt op vaste momenten een beeld uit het EINDBESTAND (niet uit de tussenframes)
// en zet er de scène en ondertitel van dat moment bij, zodat je beeld en tekst naast elkaar kunt leggen.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TMP, OUT_FILE, FFMPEG } from './config.mjs';
import { ensureDir, ffmpeg } from './lib.mjs';
import { SCENES } from './stage/scenes.js';

export function check(extraTimes = []) {
  const probe = execFileSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries',
    'stream=codec_name,codec_type,width,height,pix_fmt,r_frame_rate,nb_frames:format=duration,size', '-of', 'default=nw=1', OUT_FILE], { encoding: 'utf8' });
  console.log(probe.trim());
  const events = JSON.parse(readFileSync(join(TMP, 'events.json'), 'utf8'));
  const dir = join(TMP, 'check');
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  // per scène één beeld op twee derde (dan staat alle tekst er en is de actie bezig), plus eigen tijdstippen
  const times = events.scenes.map((s, i) => {
    const end = events.scenes[i + 1]?.t ?? events.duration;
    return { t: s.t + (end - s.t) * 0.66, id: s.id };
  }).concat(extraTimes.map((t) => ({ t, id: [...events.scenes].reverse().find((s) => s.t <= t)?.id || '?' })));
  times.sort((a, b) => a.t - b.t);
  for (const { t, id } of times) {
    const file = join(dir, `${t.toFixed(2).padStart(6, '0')}-${id}.png`);
    ffmpeg(['-ss', t.toFixed(3), '-i', OUT_FILE, '-frames:v', '1', file]);
    const sc = SCENES.find((s) => s.id === id);
    console.log(`${t.toFixed(2).padStart(6)} s  ${id.padEnd(7)} ${file}\n          ${sc?.title ? `${sc.title} | ${sc.caption || (sc.bullets || []).join(' / ')}` : '(titel-/slotkaart)'}`);
  }
  console.log('scènes:', events.scenes.map((s) => `${s.id}@${s.t.toFixed(1)}`).join('  '), `einde@${events.duration.toFixed(1)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  check(process.argv.slice(2).map(Number).filter(Number.isFinite));
}
