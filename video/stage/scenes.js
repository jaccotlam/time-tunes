// De scènes van de video, in volgorde: stapnummer, kop en ondertitel.
// Wordt gebruikt door de opname (2-record.mjs: volgorde en namen) en door het decor (stage.js: teksten).
// Controleer bij een tekstwijziging de regels in de app (#/regels): de video mag niets beloven wat de app niet doet.
//
// layout: 'title'/'end' = titel- en slotkaart; 'trio' = drie telefoons naast elkaar met de tekst erboven;
// al het andere = één telefoon links, tekst rechts met daaronder een decor (welk decor bepaalt stage.js).

const CARDS = 'Met kaartjes';
const APP = 'Alleen de app';
const MULTI = 'Ieder een eigen telefoon';
const OWN = 'Eigen playlist';

export const SCENES = [
  { id: 'title', layout: 'title' },
  {
    id: 'intro', layout: 'table', kicker: 'Wat is het?', badge: '?', title: 'Wat is TimeTunesr?',
    caption: 'Je hoort een fragment van een nummer. Uit welk jaar komt het? Speel Tijdlijn of Bingo.',
    chips: ['2–8 spelers of teams', 'twee spellen: Tijdlijn en Bingo'],
  },
  {
    id: 'modes', layout: 'table', kicker: 'Wat is het?', badge: '?', title: 'Wat is TimeTunesr?',
    caption: 'Speel op drie manieren: met geprinte kaartjes, alleen met de app, of ieder op een eigen telefoon.',
    chips: ['met kaartjes', 'alleen de app', 'ieder een eigen telefoon'], chipMarks: ['modeCards', 'modeApp', 'modeMulti'],
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

  { id: 'p1', layout: 'print', kicker: `${CARDS} · zelf printen`, badge: 'print', title: 'Print je eigen kaartjes', caption: 'Muziekkaartjes: voorop de QR-code, achterop het antwoord. Print dubbelzijdig op A4.' },
  { id: 'p2', layout: 'print', kicker: `${CARDS} · zelf printen`, badge: 'print', title: 'Print je eigen kaartjes', caption: 'Bingo met kaartjes? Print ook bingokaarten: iedere speler één, en kruis af met een pen.' },

  { id: 'd1', layout: 'digital', kicker: `${APP} · Tijdlijn · stap 1 van 3`, badge: '1', title: 'Geen kaartjes? Alleen de app', caption: 'Kies ‘Tijdlijn’, vul de namen in en geef de telefoon door.' },
  { id: 'd2', layout: 'digital', kicker: `${APP} · Tijdlijn · stap 2 van 3`, badge: '2', title: 'Kies een plek in je tijdlijn', caption: 'Tik waar het geheime nummer hoort en bevestig.' },
  { id: 'd3', layout: 'digital', kicker: `${APP} · Tijdlijn · stap 3 van 3`, badge: '3', title: 'De app laat zien of het klopt', caption: 'Goed? Dan komt de kaart in je tijdlijn. De app houdt de stand bij.' },

  { id: 'b1', layout: 'bingo', kicker: `${APP} · Bingo · stap 1 van 3`, badge: '1', title: 'Ieder een eigen bingokaart', caption: 'Kies ‘Bingo’. Op elke kaart staan andere vakjes, zoals ‘Jaren 80’ of ‘Vóór 2000’.' },
  { id: 'b2', layout: 'bingo', kicker: `${APP} · Bingo · stap 2 van 3`, badge: '2', title: 'Luister en claim één vakje', caption: 'Welk vakje past bij dit nummer? Tik het aan en bevestig.' },
  { id: 'b2good', layout: 'bingo', kicker: `${APP} · Bingo · stap 2 van 3`, badge: '2', title: 'Luister en claim één vakje', caption: 'Klopt je claim? Dan wordt het vakje afgestempeld. Fout? Dan blijft het open.' },
  { id: 'b3', layout: 'bingo', kicker: `${APP} · Bingo · stap 3 van 3`, badge: '3', title: 'Volle rij? Bingo!', caption: 'Wie het eerst een volle rij, kolom of diagonaal heeft, wint.' },

  { id: 'm1', layout: 'trio', kicker: `${MULTI} · stap 1 van 4`, badge: '1', title: 'Maak een kamer', caption: 'De spelleider tikt op ‘Maak een kamer’. Zijn toestel speelt de muziek.' },
  { id: 'm2', layout: 'trio', kicker: `${MULTI} · stap 2 van 4`, badge: '2', title: 'Doe mee met de code', caption: 'De anderen tikken op ‘Doe mee’ en vullen de code van vier letters in. Of ze scannen de QR-code.' },
  { id: 'm3', layout: 'trio', kicker: `${MULTI} · stap 3 van 4`, badge: '3', title: 'Iedereen antwoordt tegelijk', caption: 'Elk nummer kiest iedereen een vakje op zijn eigen bingokaart en zet zijn antwoord vast.' },
  { id: 'm4', layout: 'trio', kicker: `${MULTI} · stap 4 van 4`, badge: '4', title: 'De spelleider onthult', caption: 'Iedereen ziet het antwoord, wie goed zat en de tussenstand. Dit kan ook met Tijdlijn.' },

  { id: 'set1', layout: 'music', kicker: 'De muziek', badge: 'music', title: 'Fragment of heel nummer', caption: 'Standaard hoor je fragmenten van 30 seconden, zonder account. Hele nummers kan ook: via Spotify Premium.' },

  { id: 'pl1', layout: 'playlist', kicker: OWN, badge: 'music', title: 'Speel met je eigen nummers', caption: 'Maak bij ‘Eigen playlists’ een playlist. Zoek een nummer en tik erop om het toe te voegen.' },
  { id: 'pl2', layout: 'playlist', kicker: OWN, badge: 'music', title: 'Speel met je eigen nummers', caption: 'Het jaartal komt er vanzelf bij. Klopt het niet? Pas het per nummer aan.' },
  { id: 'pl3', layout: 'playlist', kicker: OWN, badge: 'music', title: 'Speel met je eigen nummers', caption: 'Tik op ‘Speel met deze playlist’: alle spelvormen gebruiken nu jouw muziek.' },

  {
    id: 'outro', layout: 'outro', kicker: 'Klaar om te spelen', badge: 'check', title: 'Gratis in je browser',
    bullets: ['Werkt op iPhone en Android', 'Zet hem op je beginscherm', 'Geen account nodig'],
  },
  { id: 'end', layout: 'end' },
];
