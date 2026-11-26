# Uitlegvideo

`timetunesr-uitleg.mp4` legt versie 3 van het spel uit aan iemand die het nog nooit zag: liggend 1920 × 1080, 30 fps, H.264, zonder geluid, ongeveer 2,5 minuut.
Links staat de echte app in een telefoonkader, rechts de ondertitel met stapnummer en een decor dat meebeweegt (tafel met kaarten, bingokaarten, printvellen, de eigen playlist).
Bij *Ieder een eigen telefoon* staan drie telefoons naast elkaar: een spelleider en twee spelers die echt met elkaar verbonden zijn.

## Opbouw

| Deel | Scènes | Wat je ziet |
| --- | --- | --- |
| Titel en intro | `title`, `intro`, `modes` | Wat het is; de drie manieren van spelen op het startscherm |
| Met kaartjes | `s1`–`s6` | Het hele spelverloop van Tijdlijn: scannen (nep-camera), verborgen luisteren, neerleggen, omdraaien, goed/fout, tien kaarten |
| Met kaartjes: printen | `p1`, `p2` | Muziekkaartjes (voor- en achterkant) en bingokaarten |
| Alleen de app: Tijdlijn | `d1`–`d3` | Namen, plek kiezen, goed |
| Alleen de app: Bingo | `b1`–`b3` | Eigen bingokaart, een goed geclaimd vakje, “Even later…”, bingo |
| Ieder een eigen telefoon | `m1`–`m4` | Kamer maken, meedoen met de code, iedereen antwoordt tegelijk, onthulling en tussenstand |
| De muziek | `set1` | Fragment van 30 seconden of hele nummers via Spotify (alleen de keuze; er wordt niets gekoppeld) |
| Eigen playlist | `pl1`–`pl3` | Nummer zoeken en toevoegen, jaartal, playlist actief maken |
| Slot | `outro`, `end` | Gratis in je browser; slotkaart met het adres |

## Opnieuw opnemen

```bash
node video/make.mjs                       # alles: camerabeelden, opname, video, nakijkbeelden
node video/make.mjs record render check   # alleen deze stappen (camerabeelden bestaan al)
```

Nodig: Node 20+, Playwright met Chromium en de devDependency `peer` (dezelfde als voor `npm run test:e2e`), ffmpeg in `/usr/bin/ffmpeg` (anders `FFMPEG=...`) en internet voor de fragmenten en voor het zoeken in de eigen playlist (iTunes).
Staat `HTTPS_PROXY` gezet, dan gaat het verkeer van de app via die proxy. Het geheel duurt ongeveer een kwartier.

Tussenbestanden (camerafilmpjes, telefoonframes, videodelen, `events.json`, samen ongeveer 0,8 GB) komen in `$TT_VIDEO_TMP`, standaard `<tmp>/timetunesr-video`. Ze horen niet in de repo.

| Stap | Script | Wat het doet |
| --- | --- | --- |
| 1 | `1-camera.mjs` | Maakt per kaart een nep-camerafilmpje (MJPEG) waarin de geprinte kaart het beeld in schuift. De kaart is de printopmaak van de app zelf, met een werkende QR-code. |
| 2 | `2-record.mjs` | Start de app (`scripts/serve.mjs`) en een lokale verbindingsserver, bedient vier telefoons in real time met Playwright en neemt hun schermen op als verliesvrije PNG-frames. Chromium krijgt de filmpjes van stap 1 als camera. Schrijft `events.json`: wanneer elke scène begon, waar er op welke telefoon getikt is en de stand van de bingokaarten. |
| 3 | `3-render.mjs` | Tekent het decor (`stage/`) frame voor frame, zet de juiste telefoonframes erin en stuurt de 1920 × 1080-screenshots direct naar ffmpeg (drie stukken tegelijk, daarna aan elkaar gezet). Dit is trager dan Playwrights `recordVideo`, maar scherp en precies 30 fps. |
| 4 | `4-check.mjs` | Haalt per scène een beeld uit het eindbestand (bij lange scènes drie) en drukt de ondertitel van dat moment erbij af. Extra tijdstippen: `node video/4-check.mjs 17.5 44`. |

Eén los beeld bekijken zonder alles te renderen: `node video/3-render.mjs --still 31.5`.
Eén deel opnemen terwijl je eraan werkt: `TT_ONLY=multi,playlist node video/2-record.mjs` (delen: `cards`, `print`, `digital`, `bingo`, `multi`, `music`, `playlist`; titel, intro en slot horen er altijd bij). Het decor van de overgeslagen delen blijft dan weg.

## Aanpassen

- `config.mjs`: welke kaarten op tafel liggen, de namen, de zaaiwaarden van Bingo en van de printbare bingokaarten, de kamercode en spelers van *Ieder een eigen telefoon*, de eigen playlist en de zoekterm, het adres in de QR-codes en op de slotkaart (`TT_PUBLIC_URL`).
- `stage/scenes.js`: alle koppen en ondertitels. Leg ze naast `#/regels` in de app, zodat de video niets belooft wat de app niet doet.
- `2-record.mjs`: het draaiboek (volgorde, tikken, hoe lang elke scène duurt).
- `stage/stage.js` en `stage/stage.css`: het decor. Kleuren en lettertypes komen uit `app/css/app.css`; de kaartjes, printvellen en bingokaarten gebruiken de opmaak van de app zelf (`app/js/screens/print.js`, `app/css/bingo.css`).

## Hoe de opname werkt

- **Schermen op ware grootte.** De CDP-screencast levert altijd beelden van 1 CSS-pixel per pixel, ook als het scherm op 1,1× of 0,9× staat. De opname gebruikt de screencast daarom alleen als seintje dat er iets veranderd is en haalt het beeld zelf op met `Page.captureScreenshot` (`lib.mjs`: `capturePage`). De hoofdtelefoon is 429 × 935 pixels (390 × 850 op 1,1×), de drie kleine telefoons 351 × 765 (0,9×); ze staan 1 op 1 in de video. Eén uitzondering: op het scanscherm is de pagina zo druk met de camera dat een screenshot 0,1 s kost. Daar bewaart de opname de beelden van de screencast zelf (390 × 850, het decor rekt ze 1,1× op), zodat de kaart vloeiend het camerabeeld in schuift.
- **Het publieke adres.** De opname draait tegen de lokale app, maar de browser ziet die onder `https://jaccotlam.github.io/time-tunes/` (`lib.mjs`: `aliasPublic`; alle bestanden komen van de lokale server, er gaat niets naar de echte site). Daardoor staat in de lobby, in de QR-codes en op het printscherm het echte adres, en toont het instellingenscherm geen waarschuwing over `localhost`.
- **Vier telefoons.** De hoofdtelefoon en de drie telefoons van *Ieder een eigen telefoon* zijn aparte browsercontexten (eigen opslag, eigen speler-id). De drie maken echt verbinding via een lokale PeerJS-server (`tests/e2e/multi-helpers.mjs`: `startSignal`, `phone`). De opname controleert dat de spelers in dezelfde kamer zitten, dat hun antwoorden bij de spelleider aankomen en dat na de onthulling op alle drie het antwoord staat.
- **Voorspelbaar.** Bingo gebruikt `timetunesr.bingoSeed.v1`, de kamer `timetunesr.multiSeed.v1`. Waar de app `Math.random()` gebruikt (Tijdlijn, de printbare bingokaarten, de kamercode) zet de opname vlak voor de tik één waarde klaar. De namen van het bingopotje en de playlist “Feestje” (vijf nummers) staan vooraf in localStorage; het zesde nummer komt er in de video bij via de zoekfunctie van de app.
- **iTunes vooraf.** Apple staat ongeveer 20 zoekvragen per minuut toe en weigert daarna een minuut lang. De opname vraagt daarom vlak voor het begin alles op wat de app in de video nodig heeft en geeft de app dan die antwoorden terug: de verse fragment-link van elk nummer dat gaat spelen (dan staat “Fragment wordt geladen…” maar 0,2 s in beeld) en de zoekvraag van de eigen playlist. Lukt die zoekvraag niet, dan gebruikt ze het bewaarde antwoord in `itunes-zoekresultaat.json` (een echte uitvoer van `itunes.apple.com/search?term=dancing queen&entity=song&country=NL&limit=25`); het logboek meldt welke van de twee het was.

## Goed om te weten

- De opname breekt af als een fragment niet start, als de app een fout geeft, als de app andere kaarten uitdeelt dan gepland, als het eerste zoekresultaat niet “Dancing Queen – ABBA (1976)” is, of als titel, artiest of jaartal zichtbaar is tijdens het verborgen afspelen (op welke telefoon dan ook). Draai de stap dan opnieuw.
- Er zit geen geluid in de video: de fragmenten uit de app zijn van Apple Music en mogen niet mee.
- De kamercode is in de app willekeurig; in de video is het altijd `KJRT`. Dat is met opzet een code met smalle letters: bij brede letters (M, W, bijvoorbeeld `MMNM`) duwt de code in de lobby de QR-code rechts buiten een scherm van 390 pixels breed. Dat is een fout in de app (`.joinbox` in `app/css/multi.css`), niet in de video.
- In het bingopotje staat na het eerste goede vakje even “Even later…” in beeld: de opname zet dan een stand van een paar rondes later klaar (`timetunesr.bingo.v1`), waarna de winnende beurt weer echt gespeeld wordt.
- Spotify is in de opname niet gekoppeld. De video laat alleen de keuze bij Instellingen zien.
- De app gebruikt het systeemlettertype. Op de machine waar deze video gemaakt is, is dat Inter; op een andere machine kan de telefoon er iets anders uitzien.
- Aan `app/`, `tests/` en `tools/` verandert dit niets. De eigen pagina's worden via Playwright onder `/__video/` op de origin van de app geserveerd.

## Discobingo-video

`discobingo-uitleg.mp4` legt Discobingo uit aan wie het nog nooit zag: 1920 × 1080, 30 fps, H.264 (yuv420p), zonder geluid, ongeveer 95 seconden, ongeveer 12 MB.
Links de spelleider als laptop of tv (de brede opmaak van de app, 1280 × 720, op 0,75× opgenomen: 960 × 540 pixels in beeld), rechts twee echte, verbonden telefoons (Anouk en Bram, 351 × 765 pixels), eronder de ondertitel met stapnummer.
Alles wat je ziet is de echte app; er wordt een compleet potje gespeeld.

```bash
node video/disco/make.mjs                 # alles: opname, video, nakijkbeelden (zo'n 6 minuten)
node video/disco/make.mjs render check    # alleen de video opnieuw (3 minuten); de opname blijft staan
node video/disco/render.mjs --still 45    # één los beeld, zonder alles te renderen
```

Eigen pipeline in `video/disco/`, los van de grote video: `config.mjs` (instellingen), `plan.mjs` (draaiboek nagerekend met de regels van de app), `record.mjs`, `render.mjs`, `check.mjs`, `make.mjs`, en het decor in `stage.html`, `stage.css`, `stage.js` en `scenes.js`.
Dezelfde aanpak als hierboven (verliesvrije frames per scherm met `capturePage` uit `lib.mjs`, `events.json`, het decor frame voor frame in ffmpeg) en dezelfde huisstijl (`app/css/app.css` en `disco.css`).
Tussenbestanden komen in `$TT_VIDEO_TMP/disco` (standaard `<tmp>/timetunesr-video/disco`), nooit in de repo.

| Stap | Scène | Tekst op beeld (kort) | Wat de opname doet |
| --- | --- | --- | --- |
| – | titel | Discobingo, muziekbingo met ieder een eigen telefoon | alleen decor |
| 1 | `room` | Maak een kamer | Spelleider tikt *Maak een kamer*; Anouk en Bram doen mee met de code |
| 2 | `lobby` | Kies Discobingo | Lobby scrollt naar *Welk spel?* en *Winnen met: 1 lijn* (kader) |
| 3 | `spin` | De discobal draait | Start; de hele draai van de bal, op alle drie de schermen |
| 4 | `card` | Ieder een eigen kaart | Telefoons scrollen naar de 5×5-kaart (kader), vier kleuren, gratis ster |
| 5 | `answer` | Luister en typ | Anouk typt “Rick Astly” (typfout), Bram “Astley” (deel van de naam) |
| 6 | `reveal` | Onthul en stempel | Onthullen; Anouk kiest een vakje en verplaatst het één keer |
| 7 | `doubt` | Twijfel? De spelleider beslist | Regie: Bram is een twijfelgeval, spelleider tikt *Goed*; Bram kiest een vakje |
| 8 | `year` | Jaartal: 2 ernaast mag | Ronde 2 (draai op ×2): 2014 bij 2016 is goed, Bram's 2020 niet |
| 9 | `later` | Even later… | Ronde 3 echt gespeeld maar op ×3 getoond, met het opschrift *Even later…* |
| 10 | `bingo` | Een lijn vol: bingo! | Ronde 4: decennium-knoppen, het laatste vakje van de rij, BINGO |
| 11 | `win` | Anouk wint! | *Naar de uitslag*, winnaarscherm met confetti |
| – | slot | adres en *Ieder een eigen telefoon → Maak een kamer* | alleen decor |

**Voorspelbaar.** `SEED` in `config.mjs` is de vaste zaaiwaarde van de kamer (`timetunesr.multiSeed.v1` bij de spelleider). `plan.mjs` rekent daarmee vooraf na wat er gebeurt (met `game.js` en `disco.js` van de app) en kan een andere zaaiwaarde zoeken (`node video/disco/plan.mjs`): ronde 1 moet Artiest of Titel zijn en Anouk moet een lijn door de ster hebben met alle vier de kleuren, zodat ze na vier rondes wint. De opname breekt af als de app andere categorieën, nummers of beoordelingen geeft dan gepland (`SCRIPT` in `config.mjs`: wat Anouk en Bram typen of tikken; de typfouten worden met `match.js` van de app gecontroleerd).
**Het nummer blijft geheim.** Tijdens het draaien, luisteren en antwoorden controleert de opname op alle drie de schermen dat titel, artiest en jaartal van het lopende nummer nergens in beeld staan; bij een lek wordt de opname afgekeurd.
**Geen internet nodig.** Er zit geen geluid in de video, dus de fragmenten zijn stil: de opname geeft de app voor elk nummer een stil fragment en een eigen iTunes-lookup-antwoord (`common.mjs`). Het deck, de titels en jaartallen zijn wel die van de app.
**De bal.** Een screenshot per scherm haalt onder deze belasting maar zo'n 14 beelden per seconde; tijdens het draaien van de bal (en op het winnaarscherm met confetti) schakelt de opname daarom per scherm om naar de beelden van de screencast zelf (JPEG, 1 CSS-pixel per pixel, ongeveer 24 per seconde). Op een rustige machine is dat vloeiender. Dit is `castFormat` in `capturePage` (`lib.mjs`, voor de andere video ongewijzigd).
**De kamercode** kiest de kamerserver zelf; bij brede letters (M, W) past de lobby niet op een telefoon (zie hierboven) en neemt het script automatisch opnieuw op (hoogstens acht keer).
**Montage.** `record.mjs` schrijft een montagelijst (`edit` in `events.json`): stukken van de opname met een scène-id en snelheid; `stage.js` maakt daar de tijdlijn van. Een scène korter of langer maken kan dus met een `hold(…)` in `record.mjs`, of met `speed` bij `seg(...)`.

Aanpassen: de teksten op beeld in `disco/scenes.js` (leg ze naast `#/regels` in de app, kopje Discobingo), de spelers en antwoorden in `disco/config.mjs`, het draaiboek en de tijden in `disco/record.mjs`, de vormgeving in `disco/stage.css`. Chromium, Node 20+, Playwright, ffmpeg en de devDependency `peer` zoals hierboven; `HTTPS_PROXY` is niet nodig. Als een andere taak de machine zwaar belast (`uptime`), kan de opname haperen: neem dan opnieuw op.
