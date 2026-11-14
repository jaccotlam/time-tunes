// Printable A4 sheets: fronts with QR codes, backs with the answer.
import qrcode from '../../vendor/qrcode-generator.mjs';
import { cardUrl } from '../logic.js';
import { icons, esc, store, logoSvg } from '../ui.js';

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
  return `<div class="pc pc-front" data-testid="print-front" data-card-id="${esc(card.id)}">
    <div class="pc-brand">${logoSvg('pc-logo')}<span>TimeTunesr</span></div>
    ${qrSvg(cardUrl(base, card.id))}
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
export function sheetsHtml(cards, base) {
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
      <div class="sheet-label">TimeTunesr · vel ${s + 1}/${total} · VOORKANT · kaarten ${esc(label)}</div>
      <div class="sheet-grid">${slots.map((c) => frontHtml(c, base)).join('')}</div>
    </div>`);
    out.push(`<div class="sheet-page" data-testid="print-sheet" data-side="back">
      <div class="sheet-label">TimeTunesr · vel ${s + 1}/${total} · ACHTERKANT · kaarten ${esc(label)}</div>
      <div class="sheet-grid">${backs.map((c) => backHtml(c)).join('')}</div>
    </div>`);
  }
  return out.join('');
}

export function render(root, { deck }) {
  const saved = store.get(BASE_KEY, null);
  const ids = deck.cards.map((c) => Number.parseInt(c.id, 10)).filter(Number.isFinite);
  const minId = ids.length ? Math.min(...ids) : 1;
  const maxId = ids.length ? Math.max(...ids) : 1;
  const opts = { base: saved || defaultBaseUrl(), mode: 'all', from: minId, to: Math.min(maxId, minId + PER_SHEET - 1) };

  root.innerHTML = `<section class="screen screen-print" data-testid="screen-print">
    <div class="no-print">
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="Terug naar start" data-testid="back-home">${icons.back}</a>
        <h1 class="topbar-title">Kaarten printen</h1>
        <span class="topbar-spacer"></span>
      </header>
      <form class="print-form panel" data-testid="print-form" autocomplete="off">
        <label class="field">
          <span>Adres van de app in de QR-codes</span>
          <input type="url" name="base" value="${esc(opts.base)}" spellcheck="false" data-testid="print-base-url" inputmode="url">
        </label>
        <p class="small muted">Standaard het adres waarop je de app nu gebruikt. Print je lokaal maar host je de app elders (bv. GitHub Pages)? Vul dan dat adres in. <button type="button" class="linklike" data-action="reset-base" data-testid="print-base-reset">Standaard herstellen</button></p>
        <p class="warn small" data-testid="print-base-warn" hidden></p>
        <fieldset class="field">
          <legend>Welke kaarten?</legend>
          <label class="radio"><input type="radio" name="mode" value="all" checked data-testid="print-all"> Alle kaarten (${deck.cards.length})</label>
          <label class="radio"><input type="radio" name="mode" value="range" data-testid="print-range"> Bereik:
            <input type="number" name="from" min="${minId}" max="${maxId}" value="${opts.from}" aria-label="Vanaf kaartnummer" data-testid="print-from">
            t/m
            <input type="number" name="to" min="${minId}" max="${maxId}" value="${opts.to}" aria-label="Tot en met kaartnummer" data-testid="print-to">
          </label>
        </fieldset>
        <p class="print-summary" data-testid="print-summary"></p>
        <button type="button" class="btn btn-primary btn-xl" data-action="print" data-testid="print-button">${icons.print}<span>Printen</span></button>
        <details class="print-tips">
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
    if (opts.mode === 'all') return deck.cards;
    const lo = Math.min(opts.from, opts.to);
    const hi = Math.max(opts.from, opts.to);
    return deck.cards.filter((c) => {
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

  function rebuild() {
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
      : 'Geen kaarten in dit bereik.';
    root.querySelector('[data-action="print"]').disabled = !cards.length;
    sheets.innerHTML = cards.length ? sheetsHtml(cards, base) : '';
    fit();
  }

  function readForm() {
    const fd = new FormData(form);
    opts.base = String(fd.get('base') || '');
    opts.mode = fd.get('mode') === 'range' ? 'range' : 'all';
    opts.from = Number(fd.get('from')) || minId;
    opts.to = Number(fd.get('to')) || maxId;
    const trimmed = opts.base.trim();
    if (trimmed && trimmed !== defaultBaseUrl()) store.set(BASE_KEY, trimmed);
    else store.remove(BASE_KEY);
  }

  const onInput = (e) => {
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
  rebuild();

  return () => {
    clearTimeout(timer);
    root.removeEventListener('click', onClick);
    window.removeEventListener('resize', fit);
  };
}
