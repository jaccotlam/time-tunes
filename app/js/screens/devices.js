// Spotify device picker: a list for the settings screen and a sheet for the player
// when Spotify has no device to play on. Shows device names only, never the song.
import * as spotify from '../spotify.js';
import { esc, icons } from '../ui.js';

const TYPE_LABEL = {
  smartphone: 'Telefoon', computer: 'Computer', speaker: 'Speaker', tablet: 'Tablet',
  tv: 'Tv', castvideo: 'Chromecast', castaudio: 'Chromecast', avr: 'Versterker', stb: 'Tv-kastje',
  audiodongle: 'Audio-dongle', gameconsole: 'Spelcomputer', automobile: 'Auto',
};
export const deviceType = (t) => TYPE_LABEL[String(t || '').toLowerCase()] || 'Apparaat';

export function deviceListHtml(devices, selectedId) {
  if (!devices.length) return '';
  return `<ul class="dev-list" data-testid="device-list">${devices.map((d) => `
    <li><button type="button" class="dev-option ${d.id === selectedId ? 'is-selected' : ''}" data-device-id="${esc(d.id)}" data-testid="device-option" aria-pressed="${d.id === selectedId}">
      <span class="dev-name">${esc(d.name)}</span>
      <span class="dev-meta">${esc(deviceType(d.type))}${d.active ? ' · actief' : ''}</span>
      ${d.id === selectedId ? `<span class="dev-check">${icons.check}</span>` : ''}
    </button></li>`).join('')}</ul>`;
}

export const NO_DEVICE_HELP = 'Open de Spotify-app op dit toestel, start even een nummer en kom terug.';

/**
 * Modal sheet "Kies een Spotify-apparaat" inside `host`.
 * onPicked(device) after a choice; onPreview() for the 30-second fragment instead.
 * Returns a function that closes the sheet.
 */
export function openDeviceSheet(host, { devices = [], onPicked, onPreview, onClose } = {}) {
  host.querySelector('.dev-sheet')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop dev-sheet';
  wrap.dataset.testid = 'device-sheet';
  host.appendChild(wrap);
  let list = devices;
  let busy = false;
  let msg = '';

  function draw() {
    wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="dev-title">
      <div class="panel dev-panel">
        <h2 id="dev-title">${list.length ? 'Kies een Spotify-apparaat' : 'Geen Spotify-apparaat gevonden'}</h2>
        <p>${list.length ? 'Op welk apparaat moet het nummer spelen?' : esc(NO_DEVICE_HELP)}</p>
        ${list.length ? `<p class="small muted">Staat je telefoon er niet bij? ${esc(NO_DEVICE_HELP)}</p>` : ''}
        ${deviceListHtml(list, spotify.getDevice()?.id)}
        ${msg ? `<p class="dev-msg" data-testid="device-msg" role="status">${esc(msg)}</p>` : ''}
        <div class="stack">
          <button class="btn ${list.length ? 'btn-ghost' : 'btn-secondary'}" type="button" data-act="refresh" data-testid="device-refresh" ${busy ? 'disabled' : ''}>${icons.restart}<span>${busy ? 'Zoeken…' : 'Opnieuw zoeken'}</span></button>
          <button class="btn btn-ghost" type="button" data-act="preview" data-testid="device-use-preview">${icons.music}<span>Speel het fragment van 30 s</span></button>
          <button class="btn btn-ghost" type="button" data-act="close" data-testid="device-close">${icons.close}<span>Sluiten</span></button>
        </div>
      </div>
    </div>`;
  }

  const close = () => { wrap.remove(); };
  wrap.addEventListener('click', async (e) => {
    if (e.target === wrap) { close(); onClose?.(); return; }
    const opt = e.target.closest('[data-device-id]');
    if (opt) {
      const d = list.find((x) => x.id === opt.dataset.deviceId);
      if (!d) return;
      spotify.setDevice(d);
      close();
      onPicked?.(d);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { close(); onClose?.(); }
    else if (act === 'preview') { close(); onPreview?.(); }
    else if (act === 'refresh' && !busy) {
      busy = true; msg = ''; draw();
      try {
        list = await spotify.getDevices();
        msg = list.length ? '' : 'Nog steeds geen apparaat. Staat de Spotify-app open en heb je even iets afgespeeld?';
      } catch (err) {
        msg = spotify.errorMessage(err);
      }
      busy = false;
      draw();
      wrap.querySelector('[data-device-id]')?.focus();
    }
  });
  draw();
  wrap.querySelector('h2')?.setAttribute('tabindex', '-1');
  wrap.querySelector('h2')?.focus();
  return close;
}
