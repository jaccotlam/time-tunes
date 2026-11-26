// Scènes van de Discobingo-video: stapnummer, kop en ondertitel (de tekst op beeld).
// Leg de tekst naast #/regels in de app (kopje Discobingo): de video mag niets beloven wat de app niet doet.
// De id's horen bij de montagelijst die record.mjs maakt (events.json: edit).
const CATS = [
  { key: 'decade', label: 'Decennium', color: '#4fb3ff' },
  { key: 'artist', label: 'Artiest / band', color: '#ff5fa8' },
  { key: 'year', label: 'Jaartal (±2)', color: '#ffc649' },
  { key: 'title', label: 'Titel', color: '#2ed3c0' },
];

export const TITLE = { word: 'Discobingo', tag: 'Muziekbingo, met ieder een eigen telefoon.', pill: 'Zo werkt het' };
export const END = {
  line: 'Ieder een eigen telefoon → Maak een kamer',
  url: 'https://jaccotlam.github.io/time-tunes/',
  pill: 'Gratis spelen in je browser · geen account nodig',
};
export { CATS };

export const SCENES = [
  { id: 'title', layout: 'title' },
  { id: 'room', title: 'Maak een kamer', caption: 'De spelleider maakt een kamer. De spelers doen mee met de code of de QR-code.' },
  { id: 'lobby', title: 'Kies Discobingo', caption: 'Discobingo staat al aan. Bij ‘Winnen met’ kies je: 1 lijn, 2 lijnen of een volle kaart.' },
  { id: 'spin', title: 'De discobal draait', caption: 'De bal kiest de vraag, eerlijk verdeeld: alle vier de soorten komen even vaak aan de beurt.' },
  { id: 'card', title: 'Ieder een eigen kaart', caption: 'Vier kleuren, vier soorten vragen. De ster in het midden is gratis.', chips: true },
  { id: 'answer', title: 'Luister en typ', caption: 'Het nummer speelt bij de spelleider. Iedereen typt zijn antwoord op de eigen telefoon.' },
  { id: 'reveal', title: 'Onthul en stempel', caption: 'Anouk typte ‘Rick Astly’: een typfoutje is nog goed. Ze kiest zelf een vakje van die kleur en kan het nog verplaatsen.' },
  { id: 'doubt', title: 'Twijfel? De spelleider beslist', caption: 'Bram typte alleen ‘Astley’. In de Regie tikt de spelleider op Goed of Fout, en elk oordeel kan met één tik om.' },
  { id: 'year', title: 'Jaartal: 2 ernaast mag', caption: 'Anouk typt 2014 bij een nummer uit 2016. Dat is nog goed.' },
  { id: 'later', title: 'Even later…', caption: 'Ronde na ronde vult je kaart. Anouk mist nog één vakje voor een lijn.', label: 'Even later…' },
  { id: 'bingo', title: 'Een lijn vol: bingo!', caption: 'Bij Decennium tik je de goede tien jaar aan. Anouk stempelt haar laatste vakje: de lijn is vol, de ster telt mee.' },
  { id: 'win', title: 'Anouk wint!', caption: 'De spelleider gaat naar de uitslag. Zin in nog een potje? Dan start hij er zo een.' },
  { id: 'end', layout: 'end' },
];
