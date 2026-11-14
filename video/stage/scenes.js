// De scènes van de video, in volgorde: stapnummer, kop en ondertitel.
// Wordt gebruikt door de opname (2-record.mjs: volgorde en namen) en door het decor (stage.js: teksten).
// Controleer bij een tekstwijziging de regels in de app (#/regels): de video mag niets beloven wat de app niet doet.

const CARDS = 'Spelen met kaarten';
const DIGI = 'Zonder kaarten';

export const SCENES = [
  { id: 'title', layout: 'title' },
  {
    id: 'intro', layout: 'table', kicker: 'Wat is het?', badge: '?', title: 'Wat is TimeTunesr?',
    caption: 'Je hoort een fragment van een nummer. Uit welk jaar komt het? Leg het op de goede plek in je tijdlijn.',
    chips: ['2–8 spelers of teams', 'één telefoon', 'kaartjes met een QR-code'],
  },
  { id: 's1', layout: 'table', kicker: `${CARDS} · stap 1 van 6`, badge: '1', title: 'Open de app', caption: 'Leg de stapel klaar en tik op ‘Scan een kaart’.' },
  { id: 's2', layout: 'table', kicker: `${CARDS} · stap 2 van 6`, badge: '2', title: 'Scan de QR-code', caption: 'Pak de bovenste kaart en houd de QR-code voor de camera.' },
  { id: 's3', layout: 'table', kicker: `${CARDS} · stap 3 van 6`, badge: '3', title: 'Luister naar het fragment', caption: 'Het nummer start vanzelf. Geen titel, geen artiest, geen jaartal.' },
  { id: 's4', layout: 'table', kicker: `${CARDS} · stap 4 van 6`, badge: '4', title: 'Leg de kaart in je tijdlijn', caption: 'Uit welk jaar komt dit nummer? Oud links, nieuw rechts.' },
  { id: 's5', layout: 'table', kicker: `${CARDS} · stap 5 van 6`, badge: '5', title: 'Draai de kaart om', caption: 'Achterop staan het jaar, de artiest en de titel.' },
  { id: 's5good', layout: 'table', kicker: `${CARDS} · stap 5 van 6`, badge: '5', title: 'Draai de kaart om', caption: 'Goed gelegd? Dan blijft de kaart in je tijdlijn liggen.' },
  { id: 's5next', layout: 'table', kicker: `${CARDS} · stap 5 van 6`, badge: '5', title: 'Draai de kaart om', caption: 'Volgende kaart: scannen, luisteren en neerleggen…' },
  { id: 's5bad', layout: 'table', kicker: `${CARDS} · stap 5 van 6`, badge: '5', title: 'Draai de kaart om', caption: 'Fout gelegd? Dan gaat de kaart uit het spel.' },
  { id: 's6', layout: 'table', kicker: `${CARDS} · stap 6 van 6`, badge: '6', title: 'Tien kaarten? Gewonnen!', caption: 'Om de beurt een kaart. Wie het eerst tien kaarten heeft, wint.' },

  { id: 'd1', layout: 'digital', kicker: `${DIGI} · stap 1 van 3`, badge: '1', title: 'Geen kaarten? Speel zonder', caption: 'Kies ‘Speel zonder kaarten’, vul de namen in en geef de telefoon door.' },
  { id: 'd2', layout: 'digital', kicker: `${DIGI} · stap 2 van 3`, badge: '2', title: 'Kies een plek in je tijdlijn', caption: 'Tik waar het geheime nummer hoort en bevestig.' },
  { id: 'd3', layout: 'digital', kicker: `${DIGI} · stap 3 van 3`, badge: '3', title: 'De app laat zien of het klopt', caption: 'Goed? Dan komt de kaart in je tijdlijn.' },
  { id: 'd3next', layout: 'digital', kicker: `${DIGI} · stap 3 van 3`, badge: '3', title: 'De app laat zien of het klopt', caption: 'Daarna is de volgende speler aan de beurt.' },
  { id: 'd3bad', layout: 'digital', kicker: `${DIGI} · stap 3 van 3`, badge: '3', title: 'De app laat zien of het klopt', caption: 'Fout? Dan gaat de kaart weg. De app houdt de stand bij.' },
  { id: 'd3win', layout: 'digital', kicker: `${DIGI} · stap 3 van 3`, badge: '3', title: 'De app laat zien of het klopt', caption: 'Ook hier wint wie het eerst tien kaarten heeft.' },

  { id: 'p1', layout: 'print', kicker: 'Zelf kaarten maken', badge: 'print', title: 'Print je eigen kaarten', caption: 'Voorop staat de QR-code, achterop het antwoord.' },
  { id: 'p2', layout: 'print', kicker: 'Zelf kaarten maken', badge: 'print', title: 'Print je eigen kaarten', caption: 'Print dubbelzijdig op A4 en knip de kaarten uit: twaalf per vel.' },

  {
    id: 'outro', layout: 'outro', kicker: 'Klaar om te spelen', badge: 'check', title: 'Gratis in je browser',
    bullets: ['Werkt op iPhone en Android', 'Zet hem op je beginscherm', 'Geen account nodig'],
  },
  { id: 'end', layout: 'end' },
];
