import { icons } from '../ui.js';
import { legendHtml } from './room-disco.js';

export const name = 'rules';

export function render(root) {
  root.innerHTML = `<section class="screen screen-rules" data-testid="screen-rules">
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Terug naar start" data-testid="back-home">${icons.back}</a>
      <h1 class="topbar-title">Spelregels</h1>
      <span class="topbar-spacer"></span>
    </header>

    <article class="rules">
      <p class="lead">TimeTunesr speelt een stukje muziek zonder te zeggen wat het is. Jij raadt uit welke tijd het komt. Er zijn twee spellen, <b>Tijdlijn</b> en <b>Bingo</b>, en twee manieren om ze te spelen: met geprinte kaartjes of alleen met de app.</p>

      <section class="rule rule-mode" data-testid="rules-modes">
        <h2><span class="rule-num">?</span>Met kaartjes of alleen de app</h2>
        <ul>
          <li><b>Met kaartjes:</b> elke muziekkaart heeft een QR-code. Scan hem met de app, luister, en draai de kaart om voor jaar, artiest en titel. De telefoon kan in het midden blijven liggen.</li>
          <li><b>Alleen de app:</b> geen kaartjes nodig. De app kiest de nummers, houdt de stand bij en controleert de antwoorden. Geef de telefoon door aan wie aan de beurt is.</li>
          <li>Speel met 2 tot 8 spelers of teams. Muziekkaartjes en bingokaarten print je via <em>Kaarten printen</em>.</li>
        </ul>
      </section>

      <section class="rule" data-testid="rules-timeline">
        <h2><span class="rule-num">1</span>Tijdlijn</h2>
        <p>Bouw een rij nummers op volgorde: oud links, nieuw rechts. Wie als eerste het afgesproken aantal kaarten (standaard <strong>10</strong>) goed heeft liggen, wint.</p>
        <h3>Met kaartjes</h3>
        <ol>
          <li>Iedereen krijgt één kaart met de jaarkant open: het begin van je tijdlijn.</li>
          <li>Pak een kaart van de stapel en scan hem. Luister naar het fragment.</li>
          <li>Leg de kaart waar jij denkt dat hij hoort: vóór, tussen of na je open kaarten.</li>
          <li>Draai hem om. Goed? Hij blijft liggen. Fout? Weg ermee. Hetzelfde jaar als je buurkaart telt altijd als goed.</li>
          <li>De volgende speler is aan de beurt.</li>
        </ol>
        <h3>Alleen de app</h3>
        <p>Kies <em>Tijdlijn</em>, vul de namen in en tik op de plek in je tijdlijn waar het nummer hoort. De app laat meteen zien of het klopt.</p>
      </section>

      <section class="rule" data-testid="rules-bingo">
        <h2><span class="rule-num">2</span>Bingo</h2>
        <p>Iedereen heeft een eigen bingokaart met vakjes zoals <em>Jaren 80</em>, <em>Vóór 2000</em>, <em>Jaar ±2</em>, <em>Artiest</em> en <em>Titel</em>. Wie als eerste een volle rij, kolom of diagonaal heeft, roept bingo en wint.</p>
        <ol>
          <li>Luister naar het fragment.</li>
          <li>Kies één open vakje op je eigen kaart dat volgens jou bij dit nummer past. Je moet altijd een vakje kiezen.</li>
          <li>Bij <em>Jaar ±2</em> noem je een jaartal: maximaal 2 jaar ernaast is goed. Bij <em>Artiest</em> of <em>Titel</em> zeg je het antwoord hardop.</li>
          <li>Onthul het antwoord. Klopt je claim? Dan is het vakje van jou. Fout? Het vakje blijft open. Over artiest en titel beslist de groep.</li>
          <li>Zijn de nummers op voordat iemand bingo heeft? Dan wint wie de meeste vakjes heeft.</li>
        </ol>
        <h3>Met kaartjes</h3>
        <p>Print de bingokaarten (iedere speler één) en pak een pen. Scan een muziekkaart, claim hardop een vakje, draai de muziekkaart om en kruis het vakje af als het klopt.</p>
        <h3>Alleen de app</h3>
        <p>Kies <em>Bingo</em> en kies 3×3 (snel potje) of 4×4 (standaard). De telefoon gaat rond: je ziet je eigen kaart, tikt een vakje aan en bevestigt. De app stempelt af en houdt ieders voortgang bij.</p>
      </section>

      <section class="rule rule-multi" data-testid="rules-multi">
        <h2><span class="rule-num">3</span>Ieder een eigen telefoon</h2>
        <p>Speel Discobingo, Bingo of Tijdlijn samen, terwijl iedereen op zijn eigen telefoon antwoordt.</p>
        <ol>
          <li>De spelleider kiest <em>Maak een kamer</em>. Zijn toestel speelt de muziek: zet het op een speaker. De spelleider mag zelf ook meespelen.</li>
          <li>De rest kiest <em>Doe mee</em> en vult de kamercode van 4 letters in, of scant de QR-code op het scherm van de spelleider.</li>
          <li>Per nummer antwoordt iedereen tegelijk op zijn eigen kaart of tijdlijn en zet zijn antwoord vast. Wijzigen mag tot de onthulling.</li>
          <li>De spelleider onthult. De app controleert alle antwoorden; bij een getypte artiest of titel tellen kleine typefouten niet, en bij twijfel draait de spelleider het oordeel met één tik om.</li>
          <li>Halen meerdere spelers in dezelfde ronde een volle rij of het doel, dan delen ze de winst. Wie later instapt, begint zo ver als wie het verst achter ligt.</li>
        </ol>
      </section>

      <section class="rule rule-multi rule-disco" data-testid="rules-disco">
        <h2><span class="rule-num">4</span>Discobingo</h2>
        <p>Bingo met een discobal, met ieder een eigen telefoon. Iedereen heeft een eigen 5×5-kaart met vier soorten vakjes en een ster in het midden.</p>
        ${legendHtml('rules-disco-legend')}
        <ol>
          <li>Per nummer draait de discobal en kiest de vraag: <em>decennium</em>, <em>artiest of band</em>, <em>jaartal</em> (2 jaar ernaast mag) of <em>titel</em>. Alle vier komen even vaak aan de beurt.</li>
          <li>Pas als de bal stilstaat, begint de muziek. Iedereen antwoordt op zijn eigen telefoon; wijzigen mag tot de onthulling. Weet je het niet? Tik op <em>Weet ik niet</em>.</li>
          <li>Een getypte artiest of titel met een kleine typefout is gewoon goed. Twijfelgeval? Dan beslist de spelleider met <em>Goed</em> of <em>Fout</em>, en hij kan elk oordeel met één tik omdraaien.</li>
          <li>Goed? Dan kies je zelf een open vakje van die kleur en stempel je het af. Verplaatsen mag tot de bal weer draait; wie niets kiest, krijgt het beste vakje.</li>
          <li>Je wint met 1 lijn, 2 lijnen of een volle kaart (dat kiest de spelleider). Een lijn is een rij, kolom of diagonaal; de ster telt mee. Halen meerdere spelers het tegelijk, dan delen ze de winst.</li>
        </ol>
        <p>Discobingo werkt alleen met de kamerserver en heeft minstens 25 nummers nodig. Wie later instapt, krijgt een kaart met evenveel vakjes als wie het verst achter ligt.</p>
      </section>

      <section class="rule rule-multi" data-testid="rules-quiz">
        <h2><span class="rule-num">5</span>Quiz</h2>
        <p>Een muziekquiz voor een feest of een avond met vrienden, met ieder een eigen telefoon. De spelleider kiest de muziek (het ingebouwde deck of een eigen playlist), het aantal vragen, de soort vragen en de bedenktijd.</p>
        <ol>
          <li>Het nummer speelt bij de spelleider. Op elke telefoon staat dezelfde vraag met vier antwoorden: <em>uit welk jaar</em>, <em>wie is de artiest</em> of <em>hoe heet dit nummer</em>.</li>
          <li>De klok start zodra de muziek speelt. Je kiest één antwoord; wijzigen kan niet.</li>
          <li>Goed is 500 punten plus tot 500 extra voor snelheid: hoe sneller, hoe meer. Meerdere goede antwoorden achter elkaar geven een kleine bonus. Fout of geen antwoord: 0 punten.</li>
          <li>Heeft iedereen geantwoord of is de tijd om, dan volgt het antwoord met de tussenstand. Na de laatste vraag staan de beste drie op het podium; gelijke punten delen de plek.</li>
        </ol>
        <p>De quiz werkt alleen met de kamerserver (die houdt de klok bij). Wie later instapt, begint op 0.</p>
      </section>

      <section class="rule rule-tips">
        <h2><span class="rule-num">★</span>Tips voor een feestje</h2>
        <ul>
          <li>Zet de telefoon op een speaker via Bluetooth: dan hoort iedereen het fragment goed.</li>
          <li>Speel in teams als je met veel mensen bent.</li>
          <li>Antwoord van een gescande kaart in de app zien? Houd <em>Toon antwoord</em> even ingedrukt.</li>
          <li>Bewaar bij bingo de makkelijke vakjes niet te lang: soms moet je een moeilijk vakje gokken.</li>
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
