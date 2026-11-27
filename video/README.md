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
- De kamercode is in de app willekeurig; in de video is het altijd `KJRT`. Toen de video gemaakt werd, duwde een code met brede letters (M, W) de QR-code in de lobby nog buiten een scherm van 390 pixels breed; dat is sindsdien opgelost in de app (`.joinbox` in `app/css/multi.css`).
- In het bingopotje staat na het eerste goede vakje even “Even later…” in beeld: de opname zet dan een stand van een paar rondes later klaar (`timetunesr.bingo.v1`), waarna de winnende beurt weer echt gespeeld wordt.
- Spotify is in de opname niet gekoppeld. De video laat alleen de keuze bij Instellingen zien.
- De app gebruikt het systeemlettertype. Op de machine waar deze video gemaakt is, is dat Inter; op een andere machine kan de telefoon er iets anders uitzien.
- Aan `app/`, `tests/` en `tools/` verandert dit niets. De eigen pagina's worden via Playwright onder `/__video/` op de origin van de app geserveerd.

## Discobingo-video

`discobingo-uitleg.mp4` legt Discobingo uit aan wie het meespeelt of de kamer host: 1920 × 1080, 30 fps, H.264 (yuv420p), zonder geluid, ongeveer 2 minuten (zo'n 120 seconden), ongeveer 18 MB.
Het laat zien hoe het spel nu werkt, met drie echte, verbonden schermen: **het grote scherm** (`#/scherm/CODE`, de tv: de ster van de video, het grootst), **het tabblad van de spelleider** (tab 1, op de laptop) en **een telefoon** (Anouk) groot genoeg om te lezen; Bram speelt mee op een tweede telefoon die klein in beeld staat en alleen groot wordt als hij de kamer verlaat en terugkomt.
Alles wat je ziet is de echte app; er wordt een compleet potje van vier rondes gespeeld. Eronder staat de ondertitel met stapnummer.

```bash
node video/disco/make.mjs                 # alles: opname, video, nakijkbeelden (zo'n 6 minuten)
node video/disco/make.mjs render check    # alleen de video opnieuw (4 minuten); de opname blijft staan
node video/disco/render.mjs --still 45    # één los beeld, zonder alles te renderen
TT_STILLS=/pad/naar/map node video/disco/make.mjs render check   # nakijkbeelden in een eigen map
```

Eigen pipeline in `video/disco/`, los van de grote video: `config.mjs` (instellingen), `plan.mjs` (draaiboek nagerekend met de regels van de app), `record.mjs`, `render.mjs`, `check.mjs`, `make.mjs`, en het decor in `stage.html`, `stage.css`, `stage.js` en `scenes.js`.
Dezelfde aanpak als hierboven (verliesvrije frames per scherm met `capturePage` uit `lib.mjs`, `events.json`, het decor frame voor frame in ffmpeg) en dezelfde huisstijl (`app/css/app.css` en `disco.css`).
Tussenbestanden komen in `$TT_VIDEO_TMP/disco` (standaard `<tmp>/timetunesr-video/disco`), nooit in de repo.

**Opstelling.** Vier echte schermen, elk met een eigen opname: de spelleider en het grote scherm zijn twee tabs van dezelfde browser (het grote scherm wordt echt geopend met de knop *Open het grote scherm*, `host-open-screen`), de twee telefoons hebben elk een eigen browsercontext. Het decor kent vier opstellingen (`LAYOUTS` in `stage.js`) en schuift er zacht tussen (0,8 s):

| Opstelling | Wanneer | Wat staat waar |
| --- | --- | --- |
| `solo` | kamer maken | alleen tab 1, in het midden |
| `tabs` | het grote scherm openen | tab 1 en tab 2 naast elkaar |
| `play` | het spel | de tv groot (1024 × 576), Anouk rechts groot (351 × 765), tab 1 en Bram klein ertussen |
| `host` | de spelleider beslist over een twijfelgeval | tab 1 groot, de tv en Bram kleiner |
| `leave` | Bram verlaat de kamer en komt terug | zoals `play`, maar Bram groot en Anouk klein |

De opname is op 0,8× (tv en laptop, 1024 × 576 pixels) en 0,9× (telefoon, 351 × 765 pixels) gemaakt en komt in beeld nooit groter dan dat, dus altijd scherp. Een opstelling per stuk kies je in `record.mjs` met `seg('scene-id', { layout: 'play' })`.

| Stap | Scène | Tekst op beeld (kort) | Wat de opname doet |
| --- | --- | --- | --- |
| – | titel | Discobingo, muziekbingo met ieder een eigen telefoon, en één groot scherm voor iedereen | alleen decor |
| 1 | `room` | Maak een kamer | Tab 1: spelleider tikt *Maak een kamer* |
| 1 | `tabs` | Het grote scherm is tab 2 | Spelleider tikt *Open het grote scherm* (kader); tab 2 gaat open en schuift naast tab 1: de laptop houdt knoppen, Spotify-login en instellingen, de tv laat alleen zien |
| 2 | `join` | Meedoen met de code of de QR | De tv toont code en QR; Anouk typt de code (vier vakjes) en haar naam op de nieuwe meedoen-pagina en staat op de tv; daarna Bram |
| 3 | `spin` | De discobal kiest de vraag | Start; de hele draai van de bal op tv, tab 1 en beide telefoons, dan de categoriekleur (Artiest) |
| 4 | `answer` | Eén vraag, één knop | Anouk typt “Rick Astly” (typfout) en tikt *Indienen*, Bram “Astley” (deel van de naam); de tv laat zien wie klaar is |
| 5 | `reveal` | Onthullen | *Onthul*; de tv toont nummer en alle antwoorden, Anouks telefoon GOED!; Bram is een twijfelgeval |
| 5 | `chip` | Een fiche op je kaart | Anouk kiest een vakje van de kleur, er valt een fiche, ze verplaatst hem één keer |
| 6 | `doubt` | Twijfel? De spelleider beslist | Tab 1 groot: de Regie met Goed/Fout (kader), de tv zegt “de spelleider beslist…” en wordt Goed; Bram kiest een vakje |
| 7 | `year` | Jaartal: 2 ernaast mag | Ronde 2: 2014 bij 2016 is goed, Brams 2020 niet |
| 8 | `leave` | Even weg? Het spel wacht niet | Ronde 3: Bram opent het menu (⋯), *Verlaat*, bevestigt; de tv toont hem offline; Anouk antwoordt alleen (typfout), de spelleider onthult |
| 8 | `back` | Terug naar de kamer | Op de meedoen-pagina tikt Bram *Terug naar kamer …*: dezelfde kaart en fiches |
| 9 | `close` | Spannend! | Anouk stempelt en heeft nog 1 vakje nodig: de tv toont de stand (*Spannend!*) |
| 9 | `bingo` | Bingo! | Ronde 4, decennium-knoppen, het laatste vakje van de rij: BINGO op de telefoon, de stand op de tv |
| 10 | `win` | De winnaar | *Naar de uitslag*: winnaarscherm met confetti op de tv en de telefoons |
| – | slot | adres, *Ieder een eigen telefoon → Maak een kamer* en de tip over het grote scherm | alleen decor |

**Voorspelbaar.** `SEED` in `config.mjs` is de vaste zaaiwaarde van de kamer (`timetunesr.multiSeed.v1` bij de spelleider). `plan.mjs` rekent daarmee vooraf na wat er gebeurt (met `game.js` en `disco.js` van de app) en kan een andere zaaiwaarde zoeken (`node video/disco/plan.mjs`): ronde 1 moet Artiest of Titel zijn (typfout is goed, alleen een deel van de naam is twijfel) en Anouk moet een lijn door de ster hebben met alle vier de kleuren, zodat ze na drie rondes nog 1 vakje nodig heeft en in ronde 4 wint. De opname breekt af als de app andere categorieën, nummers of beoordelingen geeft dan gepland (`SCRIPT` in `config.mjs`: wat Anouk en Bram typen of tikken; de typfouten worden met `match.js` van de app gecontroleerd), of als de tv de stand niet om de goede reden toont.
**Het nummer blijft geheim.** Tijdens het draaien, luisteren en antwoorden controleert de opname op alle vier de schermen (ook de tv en de tab van de spelleider) dat titel, artiest en jaartal van het lopende nummer nergens in beeld staan; bij een lek wordt de opname afgekeurd.
**Geen internet nodig.** Er zit geen geluid in de video, dus de fragmenten zijn stil: de opname geeft de app voor elk nummer een stil fragment en een eigen iTunes-lookup-antwoord (`common.mjs`). Het deck, de titels en jaartallen zijn wel die van de app.
**De bal.** Een screenshot per scherm haalt onder deze belasting maar zo'n 14 beelden per seconde; tijdens het draaien van de bal (en op het winnaarscherm met confetti) schakelt de opname daarom op alle vier de schermen om naar de beelden van de screencast zelf (JPEG, 1 CSS-pixel per pixel, ongeveer 22 per seconde). Op een rustige machine is dat vloeiender. Dit is `castFormat` in `capturePage` (`lib.mjs`). Het grote scherm beweegt altijd (discobal, lichtjes): `capturePage` wacht daarom niet meer op het eerste beeld.
**De kamercode** kiest de kamerserver zelf, dus die is bij elke opname anders.
**Montage.** `record.mjs` schrijft een montagelijst (`edit` in `events.json`): stukken van de opname met een scène-id, een opstelling en een snelheid; `stage.js` maakt daar de tijdlijn van. Een scène korter of langer maken kan dus met een `hold(…)` in `record.mjs`, of met `speed` bij `seg(...)` (nu: de bal van ronde 2 en 4 op ×2, het typen in ronde 2, 3 en 4 op ×1,3 tot ×1,5). Elke ondertitel staat minstens 3,5 s; `check` meldt het als dat niet zo is.

Aanpassen: de teksten op beeld in `disco/scenes.js` (leg ze naast `#/regels` in de app, kopje Discobingo), de spelers en antwoorden in `disco/config.mjs`, het draaiboek en de tijden in `disco/record.mjs`, de opstellingen en de vormgeving in `disco/stage.js` en `disco/stage.css`. Chromium, Node 20+, Playwright, ffmpeg en de devDependency `peer` zoals hierboven; `HTTPS_PROXY` is niet nodig. Als een andere taak de machine zwaar belast (`uptime`), kan de opname haperen: neem dan opnieuw op. Na het maken: kijk de stills die `check` schrijft (één per scène, drie bij lange scènes) na op ondertitels over een scherm, afgesneden beelden en de QR-code op de tv.
