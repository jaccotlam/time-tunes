// Maakt de Discobingo-video opnieuw: opname van de echte app -> video -> nakijkbeelden.
// Gebruik: node video/disco/make.mjs                 (alles)
//          node video/disco/make.mjs render check    (alleen die stappen; de opname blijft staan)
import { record } from './record.mjs';
import { render } from './render.mjs';
import { check } from './check.mjs';

const steps = process.argv.slice(2);
const want = (name) => steps.length === 0 || steps.includes(name);
if (want('record')) await record();
if (want('render')) await render();
if (want('check')) check();
process.exit(0); // de kamerserver van de opname houdt het proces anders open
