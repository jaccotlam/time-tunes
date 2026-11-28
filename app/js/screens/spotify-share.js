// A friend's Spotify setting (#/spotify-delen/<clientId>?van=<name>): ask first, then ADD the
// Client ID as a link (spotify.addLink: the own login uses it from now on; every link the host
// had stays) and go to the last step of the setup help (logging in).
import * as spotify from '../spotify.js';
import { icons, esc } from '../ui.js';
import { parseShareHash } from '../spotify-setup.js';
import { LINKS_MAX } from '../spotify-links.js';

export const name = 'spotify-share';

export function render(root, { navigate }) {
  const share = parseShareHash(location.hash);
  const own = spotify.getClientId();
  const who = share?.from ? esc(share.from) : 'Iemand';
  const same = share && own === share.clientId;
  const full = share && !same && !spotify.getLinks().some((l) => l.id === share.clientId) && spotify.getLinks().length >= LINKS_MAX;

  let body;
  if (!share) {
    body = `<h1>Deze link klopt niet</h1>
      <p>Er staat geen geldige Spotify-instelling in. Vraag om een nieuwe link, of stel Spotify zelf in.</p>
      <div class="stack"><a class="btn btn-primary" href="#/instellingen/spotify" data-testid="spotify-share-own">${icons.music}<span>Naar de koppelhulp</span></a></div>`;
  } else if (same) {
    body = `<h1>Deze instelling gebruik je al</h1>
      <p>Je gebruikt de Spotify-instelling${share.from ? ` van <b>${who}</b>` : ''} al op dit toestel.</p>
      <div class="stack"><a class="btn btn-primary" href="#/instellingen/spotify" data-testid="spotify-share-settings">${icons.music}<span>Naar Spotify bij Instellingen</span></a></div>`;
  } else if (full) {
    body = `<h1>Je hebt al ${LINKS_MAX} links</h1>
      <p data-testid="spotify-share-full">Er kan geen Spotify-link meer bij. Haal bij Instellingen → Spotify eerst een link weg, en open deze link daarna opnieuw.</p>
      <div class="stack"><a class="btn btn-primary" href="#/instellingen/spotify" data-testid="spotify-share-settings">${icons.music}<span>Naar Spotify bij Instellingen</span></a></div>`;
  } else {
    body = `<h1>Spotify-instelling overnemen?</h1>
      <p data-testid="spotify-share-from"><b>${who}</b> deelt een Spotify-instelling met je. Daarmee speel je in TimeTunesr hele nummers via <b>jouw eigen</b> Spotify (Premium nodig). Je hoeft daarna alleen nog in te loggen.</p>
      <p class="warn small" data-testid="spotify-share-users-note">Dit werkt alleen als ${share.from ? who : 'die persoon'} jouw Spotify-account heeft toegevoegd in de eigen Spotify-app (onder “User Management”, maximaal 5 mensen). Vraag het even na.</p>
      ${own ? '<p class="small muted" data-testid="spotify-share-keep">Je hebt al een eigen Spotify-instelling: die blijft bewaard als een van je links. Je logt voortaan in via deze nieuwe link; bij Instellingen → Spotify kies je zelf welke.</p>' : ''}
      <div class="stack">
        <button class="btn btn-primary btn-xl" type="button" data-act="accept" data-testid="spotify-share-accept">${icons.check}<span>Ja, neem over</span></button>
        <a class="btn btn-ghost" href="#/" data-testid="spotify-share-decline">${icons.close}<span>Nee, liever niet</span></a>
      </div>`;
  }

  root.innerHTML = `<section class="screen screen-center" data-testid="screen-spotify-share">
    <div class="panel sp-receive">${body}</div>
  </section>`;

  function onClick(e) {
    if (!e.target.closest('[data-act="accept"]') || !share) return;
    spotify.clearError();
    if (spotify.addLink(share.clientId, { name: share.from || '' }) === 'full') return;
    spotify.setSetup({ step: 'connect', mode: 'shared', from: share.from || '' });
    navigate('#/instellingen/spotify');
  }
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
