// Maakt de hele uitlegvideo opnieuw: camerabeelden -> opname van de app -> video -> nakijkbeelden.
// Gebruik: node video/make.mjs            (alles)
//          node video/make.mjs record render check   (alleen die stappen)
import { existsSync } from 'node:fs';
import { FILMS, camFile, makeCameraFilms } from './1-camera.mjs';
import { record } from './2-record.mjs';
import { render } from './3-render.mjs';
import { check } from './4-check.mjs';

const steps = process.argv.slice(2);
const want = (name) => steps.length === 0 || steps.includes(name);

if (steps.includes('camera') || (want('camera') && !FILMS.every((f) => existsSync(camFile(f.id))))) await makeCameraFilms();
if (want('record')) await record();
if (want('render')) await render();
if (want('check')) check();
process.exit(0); // de lokale verbindingsserver van de opname houdt het proces anders open
