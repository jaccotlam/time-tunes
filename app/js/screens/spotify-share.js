// A friend's Spotify setting (#/spotify-delen/<clientId>?van=<name>): ask first, then take
// over the Client ID and go to the last step of the setup help (logging in).
import * as spotify from '../spotify.js';
import { icons, esc } from '../ui.js';
import { parseShareHash } from '../spotify-setup.js';

export const name = 'spotify-share';

export function render(root, { navigate }) {
  const share = parseShareHash(location.hash);
  const own = spotify.getClientId();
  const who = share?.from ? esc(share.from) : 'Iemand';
  const same = share && own === share.clientId;

  let body;
  if (!share) {
    body = `<h1>Deze link klopt niet</h1>
      <p>Er staat geen geldige Spotify-instelling in. Vraag om een nieuwe link, of stel Spotify zelf in.</p>
      <div class="stack"><a class="btn btn-primary" href="#/instellingen/spotify" data-testid="spotify-share-own">${icons.music}<span>Naar de koppelhulp</span></a></div>`;
  } else if (same) {
    body = `<h1>Deze instelling gebruik je al</h1>
      <p>Je gebruikt de Spotify-instelling${share.from ? ` van <b>${who}</b>` : ''} al op dit toestel.</p>
      <div class="stack"><a class="btn btn-primary" href="#/instellingen/spotify" data-testid="spotify-share-settings">${icons.music}<span>Naar Spotify bij Instellingen</span></a></div>`;
  } else {
    body = `<h1>Spotify-instelling overnemen?</h1>
      <p data-testid="spotify-share-from"><b>${who}</b> deelt een Spotify-instelling met je. Daarmee speel je in TimeTunesr hele nummers via <b>jouw eigen</b> Spotify (Premium nodig). Je hoeft daarna alleen nog in te loggen.</p>
      <p class="warn small" data-testid="spotify-share-users-note">Dit werkt alleen als ${share.from ? who : 'die persoon'} jouw Spotify-account heeft toegevoegd in de eigen Spotify-app (onder “User Management”, maximaal 5 mensen). Vraag het even na.</p>
      ${own ? '<p class="small muted" data-testid="spotify-share-replace">Je hebt al een eigen Spotify-instelling; die wordt dan vervangen.</p>' : ''}
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
    spotify.setClientId(share.clientId);
    spotify.setSetup({ step: 'connect', mode: 'shared', from: share.from || '' });
    navigate('#/instellingen/spotify');
  }
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
