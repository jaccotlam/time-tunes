// Printable A4 sheets: fronts with QR codes, backs with the answer.
import qrcode from '../../vendor/qrcode-generator.mjs';
import { cardUrl } from '../logic.js';
import { generateCards, SQUARES, SIZES, YEAR_MARGIN } from '../bingo.js';
import { icons, esc, store, logoSvg } from '../ui.js';
import { loadBuiltinDeck } from '../deck.js';
import * as playlists from '../playlists.js';
import { playlistDeck, BUILTIN_ID } from '../playlist-logic.js';

export const name = 'print';

const BASE_KEY = 'timetunesr.printBase.v1';
const COLS = 3;
const ROWS = 4;
const PER_SHEET = COLS * ROWS;

export function defaultBaseUrl() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/** QR code as a crisp SVG (one path, scales to any size). */
export function qrSvg(text, { ecl = 'M', margin = 2 } = {}) {
  const qr = qrcode(0, ecl);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const size = n + margin * 2;
  return `<svg class="qr" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR-code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function decadeClass(year) {
  const d = Math.floor(Number(year) / 10) * 10;
  return Number.isFinite(d) ? `dec-${Math.max(1950, Math.min(2020, d))}` : '';
}

function frontHtml(card, base) {
  if (!card) return '<div class="pc pc-empty"></div>';
  // own-playlist cards carry a self-contained code (#/c/~...), so any phone can play them
  return `<div class="pc pc-front" data-testid="print-front" data-card-id="${esc(card.id)}">
    <div class="pc-brand">${logoSvg('pc-logo')}<span>TimeTunesr</span></div>
    ${qrSvg(cardUrl(base, card.code || card.id))}
    <div class="pc-num">${esc(card.id)}</div>
  </div>`;
}

function backHtml(card) {
  if (!card) return '<div class="pc pc-empty"></div>';
  return `<div class="pc pc-back ${decadeClass(card.year)}" data-testid="print-back" data-card-id="${esc(card.id)}">
    <div class="pc-artist">${esc(card.artist)}</div>
    <div class="pc-year">${esc(card.year)}</div>
    <div class="pc-title">${esc(card.title)}</div>
    <div class="pc-num">${esc(card.id)}</div>
  </div>`;
}

/** Build the sheet pairs. Backs are mirrored per row for long-edge duplex. */
export function sheetsHtml(cards, base, deckName = '') {
  const brand = deckName ? `TimeTunesr · ${esc(deckName)}` : 'TimeTunesr';
  const out = [];
  const total = Math.ceil(cards.length / PER_SHEET);
  for (let s = 0; s < total; s++) {
    const chunk = cards.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    const slots = Array.from({ length: PER_SHEET }, (_, i) => chunk[i] || null);
    const backs = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) backs.push(slots[r * COLS + (COLS - 1 - c)]);
    }
    const label = `${chunk[0].id}–${chunk[chunk.length - 1].id}`;
    out.push(`<div class="sheet-page" data-testid="print-sheet" data-side="front">
      <div class="sheet-label">${brand} · vel ${s + 1}/${total} · VOORKANT · kaarten ${esc(label)}</div>
      <div class="sheet-grid">${slots.map((c) => frontHtml(c, base)).join('')}</div>
    </div>`);
    out.push(`<div class="sheet-page" data-testid="print-sheet" data-side="back">
      <div class="sheet-label">${brand} · vel ${s + 1}/${total} · ACHTERKANT · kaarten ${esc(label)}</div>
      <div class="sheet-grid">${backs.map((c) => backHtml(c)).join('')}</div>
    </div>`);
  }
  return out.join('');
}

export const BINGO_MAX = 30;

function bingoCardHtml(card, size, no, series) {
  const cells = card.map((key) => {
    const sq = SQUARES[key];
    const write = key === 'year' ? '<span class="bk-sub">schrijf je jaartal op</span><span class="bk-write" aria-hidden="true"></span>' : `<span class="bk-sub">${esc(sq.range ? `${sq.sub} · ${sq.range}` : sq.sub)}</span>`;
    return `<div class="bk-cell kind-${sq.kind}"><span class="bk-label">${esc(sq.short || sq.label)}</span>${write}</div>`;
  }).join('');
  const nr = String(no).padStart(2, '0');
  return `<div class="bk size-${size}" data-testid="print-bingo-card" data-card-no="${no}" data-signature="${esc(card.join(','))}">
    <div class="bk-head">
      <span class="bk-brand">${logoSvg('bk-logo')}<span>TimeTunesr</span><span class="bk-bingo">Bingo</span></span>
      <span class="bk-name">Naam:<i></i></span>
      <span class="bk-no">Nr. <b>${nr}</b><small>reeks ${esc(series)} · ${size}×${size}</small></span>
    </div>
    <div class="bk-grid" style="--n:${size}">${cells}</div>
    <p class="bk-rule">Claim per fragment hardop één vakje, draai de muziekkaart om en kruis af als het klopt. Volle rij, kolom of diagonaal: <b>bingo!</b></p>
  </div>`;
}

/** Printable bingo cards: 2 per A4 (portrait, single-sided), numbered 1..n. */
export function bingoSheetsHtml(count, size, seed) {
  const cards = generateCards(count, size, seed);
  const series = (seed >>> 0).toString(36).toUpperCase().slice(-4).padStart(4, '0');
  const out = [];
  const total = Math.ceil(cards.length / 2);
  for (let s = 0; s < total; s++) {
    const pair = cards.slice(s * 2, s * 2 + 2);
    out.push(`<div class="sheet-page bingo-page" data-testid="print-bingo-sheet">
      ${pair.map((c, i) => bingoCardHtml(c, size, s * 2 + i + 1, series)).join('<div class="bk-cut" aria-hidden="true"></div>')}
    </div>`);
  }
  return out.join('');
}

export function render(root, { deck: activeDeck, params = [] }) {
  // #/print/<playlist id>: print that playlist; else the active deck.
  const wanted = params[0] && params[0] !== BUILTIN_ID ? playlists.get(params[0]) : null;
  let deck = wanted ? playlistDeck(wanted) : activeDeck;
  if (params[0] === BUILTIN_ID && activeDeck.kind !== 'builtin') {
    loadBuiltinDeck().then((d) => { if (root.isConnected && document.body.dataset.route === name) { deck = d; switchDeck(); } }).catch(() => {});
  }
  const isPlaylist = () => deck.kind === 'playlist';
  const printable = () => (isPlaylist() ? deck.cards.filter((c) => c.code) : deck.cards);
  const saved = store.get(BASE_KEY, null);
  const ids = deck.cards.map((c) => Number.parseInt(c.id, 10)).filter(Number.isFinite);
  const minId = ids.length ? Math.min(...ids) : 1;
  const maxId = ids.length ? Math.max(...ids) : 1;
  const opts = {
    base: saved || defaultBaseUrl(), mode: 'all', from: minId, to: Math.min(maxId, minId + PER_SHEET - 1),
    kind: 'cards', bingoCount: 8, bingoSize: 4, bingoSeed: (Math.random() * 2 ** 32) >>> 0,
  };

  root.innerHTML = `<section class="screen screen-print" data-testid="screen-print">
    <div class="no-print">
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="Terug naar start" data-testid="back-home">${icons.back}</a>
        <h1 class="topbar-title">Kaarten printen</h1>
        <span class="topbar-spacer"></span>
      </header>
      <form class="print-form panel" data-testid="print-form" autocomplete="off">
        <fieldset class="field print-kind">
          <legend>Wat wil je printen?</legend>
          <div class="kind-pick">
            <label class="kind-opt"><input type="radio" name="kind" value="cards" checked data-testid="print-kind-cards"><span><b>Muziekkaartjes</b><small>QR voor, antwoord achter. Voor Tijdlijn én Bingo.</small></span></label>
            <label class="kind-opt"><input type="radio" name="kind" value="bingo" data-testid="print-kind-bingo"><span><b>Bingokaarten</b><small>Eén per speler, 2 per A4. Kruis af met een pen.</small></span></label>
          </div>
        </fieldset>
        <div class="print-opts-bingo" hidden>
          <div class="bingo-print-row">
            <label class="field"><span>Aantal kaarten</span>
              <input type="number" name="bingoCount" min="1" max="${BINGO_MAX}" value="${opts.bingoCount}" inputmode="numeric" data-testid="print-bingo-count">
            </label>
            <fieldset class="field">
              <legend>Formaat</legend>
              <div class="radio-row">
                ${SIZES.map((n) => `<label class="radio"><input type="radio" name="bingoSize" value="${n}" ${n === opts.bingoSize ? 'checked' : ''} data-testid="print-bingo-size-${n}"> ${n}×${n}</label>`).join('')}
              </div>
            </fieldset>
          </div>
          <p class="small muted">Elke kaart is anders en genummerd. Niet tevreden? <button type="button" class="linklike" data-action="reshuffle" data-testid="print-bingo-reshuffle">Maak andere kaarten</button></p>
          <details class="print-tips">
            <summary>Zo speel je bingo met kaartjes</summary>
            <ul>
              <li>Print enkelzijdig op A4, schaal 100%, en knip elk vel door het midden.</li>
              <li>Iedereen krijgt een bingokaart en een pen. Je hebt ook de muziekkaartjes nodig.</li>
              <li>Scan een muziekkaart, luister, en claim hardop één open vakje (bij <em>Jaar ±${YEAR_MARGIN}</em> schrijf je eerst je jaartal op).</li>
              <li>Draai de muziekkaart om. Klopt je claim? Kruis het vakje af. Bij <em>Artiest</em> en <em>Titel</em> beslist de groep.</li>
            </ul>
          </details>
        </div>
        <div class="print-opts-cards">
        <label class="field">
          <span>Adres van de app in de QR-codes</span>
          <input type="url" name="base" value="${esc(opts.base)}" spellcheck="false" data-testid="print-base-url" inputmode="url">
        </label>
        <p class="small muted">Standaard het adres waarop je de app nu gebruikt. Print je lokaal maar host je de app elders (bv. GitHub Pages)? Vul dan dat adres in. <button type="button" class="linklike" data-action="reset-base" data-testid="print-base-reset">Standaard herstellen</button></p>
        <p class="warn small" data-testid="print-base-warn" hidden></p>
        <label class="field">
          <span>Welke muziek?</span>
          <select name="deck" data-testid="print-deck" class="print-deck">
            <option value="${BUILTIN_ID}">TimeTunesr-deck (ingebouwd)</option>
            ${playlists.all().map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (eigen playlist)</option>`).join('')}
          </select>
        </label>
        <p class="small muted print-deck-note" data-testid="print-deck-note"></p>
        <fieldset class="field">
          <legend>Welke kaarten?</legend>
          <label class="radio"><input type="radio" name="mode" value="all" checked data-testid="print-all"> Alle kaarten (<span data-slot="count">${deck.cards.length}</span>)</label>
          <label class="radio"><input type="radio" name="mode" value="range" data-testid="print-range"> Bereik:
            <input type="number" name="from" min="${minId}" max="${maxId}" value="${opts.from}" aria-label="Vanaf kaartnummer" data-testid="print-from">
            t/m
            <input type="number" name="to" min="${minId}" max="${maxId}" value="${opts.to}" aria-label="Tot en met kaartnummer" data-testid="print-to">
          </label>
        </fieldset>
        </div>
        <p class="print-summary" data-testid="print-summary"></p>
        <button type="button" class="btn btn-primary btn-xl" data-action="print" data-testid="print-button">${icons.print}<span>Printen</span></button>
        <details class="print-tips print-opts-cards">
          <summary>Tips voor goed printen</summary>
          <ul>
            <li>Print op A4, schaal <strong>100%</strong> (niet "passend maken"), bij voorkeur stevig papier van 160–250 g/m².</li>
            <li>Kies <strong>dubbelzijdig, spiegelen over de lange zijde</strong>. De achterkanten zijn al gespiegeld, zodat elk antwoord precies achter zijn QR-code valt.</li>
            <li>Geen duplexprinter? Print eerst alle oneven pagina's, leg de stapel terug en print de even pagina's.</li>
            <li>Knip langs de stippellijnen. Elke kaart is 6,2 × 6,2 cm.</li>
            <li>Test eerst één vel: scan een kaart en kijk of het nummer achterop klopt.</li>
          </ul>
        </details>
      </form>
      <h2 class="preview-title">Voorbeeld</h2>
    </div>
    <div class="sheets-wrap"><div class="sheets" data-testid="print-sheets"></div></div>
  </section>`;

  const form = root.querySelector('form');
  const sheets = root.querySelector('.sheets');
  const summary = root.querySelector('.print-summary');
  const warn = root.querySelector('[data-testid="print-base-warn"]');
  let timer = 0;

  function selected() {
    if (opts.mode === 'all') return printable();
    const lo = Math.min(opts.from, opts.to);
    const hi = Math.max(opts.from, opts.to);
    return printable().filter((c) => {
      const n = Number.parseInt(c.id, 10);
      return Number.isFinite(n) && n >= lo && n <= hi;
    });
  }

  function fit() {
    const wrap = root.querySelector('.sheets-wrap');
    if (!wrap) return;
    const mm = 96 / 25.4;
    const scale = Math.min(1, (wrap.clientWidth - 2) / (210 * mm));
    sheets.style.setProperty('--preview-scale', String(scale));
  }

  function rebuildBingo() {
    const n = Math.max(1, Math.min(BINGO_MAX, Math.round(opts.bingoCount) || 1));
    const pages = Math.ceil(n / 2);
    warn.hidden = true;
    summary.innerHTML = `<b>${n}</b> ${n === 1 ? 'bingokaart' : 'bingokaarten'} ${opts.bingoSize}×${opts.bingoSize} · ${pages} ${pages === 1 ? 'vel' : 'vellen'} A4 (2 per vel, enkelzijdig)`;
    root.querySelector('[data-action="print"]').disabled = false;
    sheets.innerHTML = bingoSheetsHtml(n, opts.bingoSize, opts.bingoSeed);
    fit();
  }

  function rebuild() {
    const isBingo = opts.kind === 'bingo';
    root.querySelectorAll('.print-opts-cards').forEach((el) => { el.hidden = isBingo; });
    root.querySelector('.print-opts-bingo').hidden = !isBingo;
    document.body.dataset.print = opts.kind;
    if (isBingo) { rebuildBingo(); return; }
    const cards = selected();
    const base = opts.base.trim() || defaultBaseUrl();
    let w = '';
    if (!/^https?:\/\//i.test(base)) w = 'Het adres moet beginnen met http:// of https://.';
    else if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(base)) {
      w = 'Let op: dit is een lokaal adres. De QR-codes werken dan alleen op dit netwerk; de telefooncamera heeft voor scannen in de app bovendien https nodig.';
    }
    warn.hidden = !w;
    warn.textContent = w;
    const nSheets = Math.ceil(cards.length / PER_SHEET);
    summary.innerHTML = cards.length
      ? `<b>${cards.length}</b> ${cards.length === 1 ? 'kaart' : 'kaarten'} · ${nSheets} ${nSheets === 1 ? 'vel' : 'vellen'} · ${nSheets * 2} pagina's (voor + achter)`
      : (deck.cards.length ? 'Geen kaarten in dit bereik.' : 'Deze playlist heeft nog geen nummers.');
    root.querySelector('[data-action="print"]').disabled = !cards.length;
    sheets.innerHTML = cards.length ? sheetsHtml(cards, base, isPlaylist() ? deck.name : '') : '';
    fit();
  }

  function deckNote() {
    const note = root.querySelector('[data-testid="print-deck-note"]');
    const skipped = deck.cards.length - printable().length;
    note.hidden = !isPlaylist();
    note.innerHTML = isPlaylist()
      ? `De QR-codes van een eigen playlist werken op elke telefoon met TimeTunesr, ook zonder deze playlist. Het jaartal zit (onleesbaar) in de code; titel en artiest haalt de app op bij Apple Music.${skipped ? ` <b>${skipped} ${skipped === 1 ? 'nummer staat' : 'nummers staan'} niet bij Apple Music en ${skipped === 1 ? 'kan' : 'kunnen'} niet geprint worden.</b>` : ''}`
      : '';
  }

  function switchDeck() {
    const ids2 = deck.cards.map((c) => Number.parseInt(c.id, 10)).filter(Number.isFinite);
    const lo = ids2.length ? Math.min(...ids2) : 1;
    const hi = ids2.length ? Math.max(...ids2) : 1;
    form.elements.deck.value = deck.id || BUILTIN_ID;
    root.querySelector('[data-slot="count"]').textContent = String(printable().length);
    for (const [el, v] of [[form.elements.from, lo], [form.elements.to, Math.min(hi, lo + PER_SHEET - 1)]]) {
      el.min = String(lo); el.max = String(hi); el.value = String(v);
    }
    form.querySelector('input[value="all"]').checked = true;
    deckNote();
    readForm();
    rebuild();
  }

  async function chooseDeck(id) {
    const p = id !== BUILTIN_ID ? playlists.get(id) : null;
    try { deck = p ? playlistDeck(p) : await loadBuiltinDeck(); } catch { return; }
    switchDeck();
  }

  function readForm() {
    const fd = new FormData(form);
    opts.base = String(fd.get('base') || '');
    opts.mode = fd.get('mode') === 'range' ? 'range' : 'all';
    opts.from = Number(fd.get('from')) || minId;
    opts.to = Number(fd.get('to')) || maxId;
    opts.kind = fd.get('kind') === 'bingo' ? 'bingo' : 'cards';
    opts.bingoCount = Number(fd.get('bingoCount')) || 1;
    opts.bingoSize = SIZES.includes(Number(fd.get('bingoSize'))) ? Number(fd.get('bingoSize')) : 4;
    const trimmed = opts.base.trim();
    if (trimmed && trimmed !== defaultBaseUrl()) store.set(BASE_KEY, trimmed);
    else store.remove(BASE_KEY);
  }

  const onInput = (e) => {
    if (e.target.name === 'deck') { chooseDeck(e.target.value); return; }
    if (e.target.type === 'radio') { readForm(); rebuild(); return; }
    if (e.target.name === 'from' || e.target.name === 'to') {
      form.querySelector('input[value="range"]').checked = true;
    }
    readForm();
    clearTimeout(timer);
    timer = setTimeout(rebuild, 250);
  };
  const onClick = (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'print') {
      clearTimeout(timer);
      readForm();
      rebuild();
      window.print();
    } else if (a.dataset.action === 'reshuffle') {
      opts.bingoSeed = (Math.random() * 2 ** 32) >>> 0;
      readForm();
      rebuild();
    } else if (a.dataset.action === 'reset-base') {
      form.elements.base.value = defaultBaseUrl();
      readForm();
      rebuild();
    }
  };
  form.addEventListener('input', onInput);
  form.addEventListener('submit', (e) => e.preventDefault());
  root.addEventListener('click', onClick);
  window.addEventListener('resize', fit);
  form.elements.deck.value = deck.id || BUILTIN_ID;
  deckNote();
  rebuild();

  return () => {
    delete document.body.dataset.print;
    clearTimeout(timer);
    root.removeEventListener('click', onClick);
    window.removeEventListener('resize', fit);
  };
}
