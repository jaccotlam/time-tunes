// Scènes van de Discobingo-video: stapnummer, kop en ondertitel (de tekst op beeld).
// Leg de tekst naast #/regels in de app (kopje Discobingo): de video mag niets beloven wat de app niet doet.
// De id's horen bij de montagelijst die record.mjs maakt (events.json: edit). `step` is het stapnummer in
// "Stap n van N"; scènes met hetzelfde stapnummer horen bij elkaar.
export const TITLE = {
  word: 'Discobingo',
  tag: 'Muziekbingo met ieder een eigen telefoon, en één groot scherm voor iedereen.',
  pill: 'Zo werkt het',
};
export const END = {
  line: 'Ieder een eigen telefoon → Maak een kamer',
  url: 'https://jaccotlam.github.io/time-tunes/',
  tip: 'Tip: open het grote scherm in een tweede tab en zet die op de tv.',
  pill: 'Gratis spelen in je browser · geen account nodig',
};

export const SCENES = [
  { id: 'title', layout: 'title' },
  { id: 'room', step: 1, title: 'Maak een kamer', caption: 'De spelleider maakt de kamer op de laptop. Dat is tab 1: daar staan alle knoppen.' },
  { id: 'tabs', step: 1, title: 'Het grote scherm is tab 2', caption: 'Met ‘Open het grote scherm’ gaat er een tweede tab open. Zet die op de tv. De laptop houdt de knoppen, de Spotify-login en de instellingen; de tv laat alleen zien.' },
  { id: 'join', step: 2, title: 'Meedoen met de code of de QR', caption: 'Op de tv staan de code en een grote QR-code. Op de telefoon typ je de code en je naam, en je staat meteen op de tv.' },
  { id: 'spin', step: 3, title: 'De discobal kiest de vraag', caption: 'Na Start draait de bal op de tv en op elke telefoon. Alle soorten vragen komen om de beurt, eerlijk verdeeld.' },
  { id: 'answer', step: 4, title: 'Eén vraag, één knop', caption: 'Je telefoon toont steeds maar één ding: de vraag, één invulveld en Indienen. Op de tv zie je wie al klaar is.' },
  { id: 'reveal', step: 5, title: 'Onthullen', caption: 'De spelleider tikt op Onthul. De tv toont het nummer en ieders antwoord. ‘Rick Astly’ met een typfout is nog gewoon goed.' },
  { id: 'chip', step: 5, title: 'Een fiche op je kaart', caption: 'Goed? Tik een vakje met de kleur van de vraag: er valt een fiche. Je kunt hem nog verplaatsen tot de volgende ronde.' },
  { id: 'doubt', step: 6, title: 'Twijfel? De spelleider beslist', caption: 'Bram typte alleen ‘Astley’. De tv zegt: de spelleider beslist. In de Regie tikt de spelleider op Goed of Fout.' },
  { id: 'year', step: 7, title: 'Jaartal: 2 ernaast mag', caption: 'Elke ronde is een andere vraag. Bij een jaartal mag je er twee naast zitten: 2014 bij een nummer uit 2016 is nog goed.' },
  { id: 'leave', step: 8, title: 'Even weg? Het spel wacht niet', caption: 'Bram verlaat de kamer. De tv laat zien dat hij weg is, en niemand hoeft op hem te wachten. Zijn plek blijft bewaard.' },
  { id: 'back', step: 8, title: 'Terug naar de kamer', caption: 'Op de meedoen-pagina staat ‘Terug naar kamer’. Eén tik en Bram heeft dezelfde kaart en dezelfde fiches terug.' },
  { id: 'close', step: 9, title: 'Spannend!', caption: 'De stand staat niet de hele tijd in beeld: alleen af en toe, en als iemand nog 1 vakje nodig heeft.' },
  { id: 'bingo', step: 9, title: 'Bingo!', caption: 'Anouk stempelt haar laatste vakje: de lijn is vol, de ster telt mee. BINGO, op haar telefoon.' },
  { id: 'win', step: 10, title: 'De winnaar', caption: 'De tv laat de winnaar zien. Zin in nog een potje? Dan start de spelleider er zo een.' },
  { id: 'end', layout: 'end' },
];
