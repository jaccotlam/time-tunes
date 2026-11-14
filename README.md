# TimeTunesr

Een muziekpartyspel voor groepen: een gratis webapp plus fysieke kaarten met QR-codes.
Scan een kaart en de app speelt een fragment af, zonder titel, artiest of jaartal te tonen.
Leg de kaart op de juiste plek in je eigen tijdlijn en draai hem om: achterop staan jaar, artiest en titel.

Er zijn twee spellen, **Tijdlijn** en **Bingo**, en twee manieren van spelen:

- **Met kaartjes**: geprinte muziekkaarten met QR-code. Scan een kaart, luister en draai hem om voor het antwoord. Voor Bingo print je daarnaast bingokaarten en kruis je af met een pen.
- **Alleen de app**: geen kaartjes nodig. Eén telefoon gaat rond; de app kiest de nummers, controleert de antwoorden en houdt de stand bij.

### Bingo

Iedere speler (2–8) heeft een eigen, willekeurige bingokaart van 3×3 (snel potje) of 4×4 (standaard). Na elk fragment claimt de speler één open vakje: een decennium (*Jaren 80*), een ruime periode (*Vóór 2000*), *Jaar ±2* (jaartal noemen, maximaal 2 jaar ernaast) of *Artiest*/*Titel* (hardop zeggen, de groep beslist). Goed = afgestempeld, fout = blijft open. Wie het eerst een volle rij, kolom of diagonaal heeft, wint; zijn de nummers op, dan wint wie de meeste vakjes heeft.

Elke kaart mengt makkelijke en moeilijke vakjes: per rij, kolom en diagonaal hoogstens één periodevakje en één *Jaar ±2*, nooit twee keer *Artiest* of *Titel*. Een 4×4-kaart heeft 4 periodes, 6 decennia, 2× ±2, 2× artiest en 2× titel; 3×3 heeft 2, 4, 1, 1, 1. Een simulatie met het echte deck (spelers die ~60% van de decennia goed hebben) geeft voor 4 spelers op 4×4 gemiddeld 8 rondes (10% binnen 6, 90% binnen 10), op 3×3 ongeveer 4.

Voorspelbaar potje (tests, uitlegvideo): zet `localStorage['timetunesr.bingoSeed.v1'] = '7'` (een geheel getal). Elk nieuw bingopotje gebruikt dan die zaaiwaarde: dezelfde kaarten en dezelfde volgorde van nummers. De lopende stand staat in `timetunesr.bingo.v1` (los van het tijdlijnspel in `timetunesr.game.v1`).

De app is een installeerbare PWA (iPhone Safari en Android Chrome) in gewone HTML, CSS en JavaScript-modules. Er is geen build-stap en er zijn geen externe diensten nodig, behalve de 30-seconden-previews van Apple Music.

## Lokaal draaien

```bash
npm start          # statische server voor app/ op http://localhost:8080/
npm test           # unit-tests van de spellogica (node --test)
npm run test:e2e   # end-to-end met Playwright + Chromium (moet al geïnstalleerd zijn)
```

`npm start` heeft geen dependencies. Een andere poort kies je met `node scripts/serve.mjs --port 3000`.
Op een telefoon in hetzelfde netwerk werkt alles behalve de camera-scanner, want die vereist https of localhost. Typ dan het kaartnummer in, of scan de QR-code met de gewone camera-app.

## Structuur

| Pad | Inhoud |
| --- | --- |
| `app/` | De complete site (dit is wat er gehost wordt) |
| `app/data/deck.json` | Het kaartendeck (`id`, `title`, `artist`, `year`, `itunesId`, `previewUrl`, `trackViewUrl`) |
| `app/js/logic.js` | Pure spellogica zonder DOM: QR-tekst parsen, plek controleren, beurten, winnaar, schudden |
| `app/js/bingo.js` | Pure bingologica zonder DOM: kaarten genereren (zaaibare RNG), claims controleren, lijn en winnaar bepalen |
| `app/js/screens/` | De schermen: start, scannen, kaart afspelen, Tijdlijn (digitaal), Bingo, printen, spelregels |
| `app/css/bingo.css` | Opmaak van het bingospel en de printbare bingokaarten |
| `app/vendor/` | jsQR (QR lezen, Apache-2.0) en qrcode-generator (QR maken, MIT), met licenties |
| `app/sw.js` | Service worker: app-shell offline, netwerk eerst zodat updates direct doorkomen |
| `tests/unit/` | `node --test` voor de spellogica |
| `tests/e2e/` | Playwright-scripts (kaart scannen met nep-camera, Tijdlijn, Bingo, printen, PWA) |

Routes (hash): `#/` start, `#/scan`, `#/c/042` (verborgen afspeelscherm voor kaart 042), `#/spel` (Tijdlijn), `#/bingo`, `#/print`, `#/regels`, `#/instellingen`.

## Kaarten printen

1. Open de app op het adres waar hij gehost wordt en kies **Kaarten printen**.
2. Controleer het adres voor de QR-codes. Standaard is dat het huidige adres van de app. Print je vanaf `localhost` maar host je op GitHub Pages? Vul dan het Pages-adres in, bijvoorbeeld `https://<gebruiker>.github.io/time-tunes/`.
3. Kies alle kaarten of een bereik en klik op **Printen**.
4. Print op A4, schaal 100%, **dubbelzijdig met spiegelen over de lange zijde**. De achterkanten zijn per rij gespiegeld, zodat elk antwoord achter de goede QR-code valt. Knip langs de stippellijnen (kaarten van 6,2 × 6,2 cm).

**Bingokaarten**: kies op de printpagina *Bingokaarten*, het aantal (1–30) en 3×3 of 4×4. Elke kaart is anders en genummerd; er passen 2 op een A4 (enkelzijdig, knip het vel door het midden). *Maak andere kaarten* geeft een nieuwe reeks.

Een QR-code bevat de volledige app-URL met `#/c/<id>`. Zo opent ook de gewone camera-app van de telefoon direct het verborgen afspeelscherm.

## Hosten op GitHub Pages

De workflow `.github/workflows/pages.yml` publiceert de map `app/` bij elke push naar `main`; hij is ook handmatig te starten. Eenmalig instellen: **Settings → Pages → Source: GitHub Actions**. Alle paden zijn relatief, dus de app werkt ook vanuit een submap zoals `/time-tunes/`.

## Bekende beperkingen

- Je hoort alleen de **30-seconden-previews** van Apple Music/iTunes. Per kaart wordt eerst een verse preview-link opgezocht (`itunes.apple.com/lookup`). Lukt dat niet, dan valt de app terug op de link in het deck. Niet elk nummer heeft in elk land een preview.
- Voor afspelen is internet nodig. De app zelf laadt na het eerste bezoek ook offline.
- De **camera** werkt alleen via https of op localhost. iOS Safari heeft geen `BarcodeDetector`, daarom leest jsQR daar de QR-codes.
- iOS staat geluid pas toe na een tik. Wie een kaart met de gewone camera-app opent, krijgt daarom een grote knop **Speel af**.
- Volledige nummers via Spotify zouden voor elke speler Spotify Premium vereisen, plus een eigen geregistreerde Spotify-developer-app. Dat is bewust buiten deze versie gehouden.
