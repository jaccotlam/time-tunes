import { icons } from '../ui.js';

export const name = 'rules';

export function render(root) {
  root.innerHTML = `<section class="screen screen-rules" data-testid="screen-rules">
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Terug naar start" data-testid="back-home">${icons.back}</a>
      <h1 class="topbar-title">Spelregels</h1>
      <span class="topbar-spacer"></span>
    </header>

    <article class="rules">
      <p class="lead">In TimeTunesr hoor je een fragment van een nummer, zonder titel of artiest. Raad uit welk jaar het komt en leg de kaart op de goede plek in jouw eigen tijdlijn. Wie als eerste een volle tijdlijn heeft, wint.</p>

      <section class="rule">
        <h2><span class="rule-num">1</span>Voorbereiden</h2>
        <ul>
          <li>Speel met 2 tot 8 spelers of teams. Je hebt één telefoon met TimeTunesr nodig.</li>
          <li>Schud de kaarten en leg de stapel met de QR-kant naar boven.</li>
          <li>Iedereen krijgt één <strong>startkaart</strong> met de jaarkant open voor zich. Dat is het begin van je tijdlijn.</li>
          <li>Spreek af hoeveel kaarten je nodig hebt om te winnen. Standaard is dat <strong>10</strong>, inclusief de startkaart.</li>
        </ul>
      </section>

      <section class="rule">
        <h2><span class="rule-num">2</span>Een beurt</h2>
        <ol>
          <li>Pak de bovenste kaart en scan de QR-code met de app (of typ het kaartnummer). Het fragment start zonder te verklappen wat het is.</li>
          <li>Luister goed. Overleg mag, maar de speler aan de beurt beslist.</li>
          <li>Leg de kaart in je tijdlijn: links van, tussen of rechts van je open kaarten. Oud links, nieuw rechts.</li>
          <li>Draai de kaart om. Klopt de plek? Dan blijft hij open liggen. Fout? Dan gaat de kaart uit het spel.</li>
          <li>Hetzelfde jaar als de kaart ernaast is altijd goed, aan welke kant je hem ook legt.</li>
          <li>Daarna is de volgende speler (met de klok mee) aan de beurt.</li>
        </ol>
      </section>

      <section class="rule">
        <h2><span class="rule-num">3</span>Winnen</h2>
        <p>Wie als eerste het afgesproken aantal kaarten goed in zijn tijdlijn heeft liggen, wint. Zijn de kaarten op? Dan wint wie de langste tijdlijn heeft.</p>
      </section>

      <section class="rule">
        <h2><span class="rule-num">4</span>Spelen zonder kaarten</h2>
        <p>Geen kaarten bij de hand? Kies <em>Speel zonder kaarten</em> op het startscherm. Vul de namen in en geef de telefoon door:</p>
        <ul>
          <li>De app speelt een willekeurig nummer dat nog niet geweest is.</li>
          <li>Tik op de plek in je tijdlijn waar het nummer hoort en bevestig.</li>
          <li>De app laat meteen zien of het goed was, en houdt de stand en tijdlijnen bij. Ook als je de pagina per ongeluk herlaadt.</li>
        </ul>
      </section>

      <section class="rule rule-tips">
        <h2><span class="rule-num">★</span>Tips voor een feestje</h2>
        <ul>
          <li>Zet de telefoon op een speaker via Bluetooth: dan hoort iedereen het fragment goed.</li>
          <li>Speel in teams als je met veel mensen bent.</li>
          <li>Wil je het antwoord in de app zien? Houd <em>Toon antwoord</em> even ingedrukt. Zo verklap je het niet per ongeluk.</li>
          <li>Te makkelijk? Laat de speler ook de artiest of titel raden voor de eer.</li>
        </ul>
      </section>
    </article>

    <div class="stack">
      <a class="btn btn-primary btn-xl" href="#/scan" data-testid="rules-scan">${icons.scan}<span>Scan een kaart</span></a>
      <a class="btn btn-ghost" href="#/" data-testid="rules-home">${icons.home}<span>Naar start</span></a>
    </div>
  </section>`;
  return null;
}
