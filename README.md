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
| `app/js/spotify.js`, `spotify-match.js`, `pkce.js` | Spotify-koppeling: login (PKCE), afspelen op een Spotify-apparaat, kaart → nummer |
| `app/js/logic.js` | Pure spellogica zonder DOM: QR-tekst parsen, plek controleren, beurten, winnaar, schudden |
| `app/js/bingo.js` | Pure bingologica zonder DOM: kaarten genereren (zaaibare RNG), claims controleren, lijn en winnaar bepalen |
| `app/js/screens/` | De schermen: start, scannen, kaart afspelen, Tijdlijn (digitaal), Bingo, printen, spelregels |
| `app/css/bingo.css` | Opmaak van het bingospel en de printbare bingokaarten |
| `app/js/playlist-logic.js`, `playlists.js`, `itunes.js`, `spotify-playlists.js`, `screens/playlist*.js`, `css/playlists.css` | Eigen playlists: pure logica (regels, jaarkeuze, QR- en deelcodes), opslag, iTunes-zoeken, Spotify-import, schermen |
| `app/vendor/` | jsQR (QR lezen, Apache-2.0) en qrcode-generator (QR maken, MIT), met licenties |
| `app/sw.js` | Service worker: app-shell offline, netwerk eerst zodat updates direct doorkomen |
| `tests/unit/` | `node --test` voor de spellogica |
| `tests/e2e/` | Playwright-scripts (kaart scannen met nep-camera, Tijdlijn, Bingo, printen, PWA) |

Routes (hash): `#/` start, `#/scan`, `#/c/042` (verborgen afspeelscherm voor kaart 042), `#/c/~<code>` (kaart van een eigen playlist), `#/spel` (Tijdlijn), `#/bingo`, `#/print` (of `#/print/<playlist-id>`), `#/regels`, `#/instellingen`, `#/playlists` (muziek kiezen), `#/playlists/<id>` (een playlist bewerken), `#/pl/<code>` (gedeelde playlist ontvangen).

## Eigen playlist

Spelen met je eigen nummers in plaats van het ingebouwde deck kan in alle spelvormen: scannen met kaartjes, Tijdlijn, Bingo (en Samen spelen, dat ook het actieve deck gebruikt). Tik op het startscherm op de regel **Muziek: … — wijzig** (of ga via **Instellingen → Eigen playlists**) en maak een playlist.

**Nummers toevoegen** kan op drie manieren:

- **Zoeken** via de iTunes Search API. Er wordt pas gezocht als je even stopt met typen (of op het vergrootglas tikt). Karaoke-, tribute-, cover- en liveversies komen onderaan.
- **Lijst plakken**: één nummer per regel als `Artiest - Titel`, eventueel met `, 1987` of `(1987)` erachter. De app zoekt de regels één voor één op (Apple staat ongeveer 20 zoekvragen per minuut toe, dus ±3 s per regel) met een voortgangsbalk. Stoppen kan altijd; gevonden nummers blijven staan, de rest en de niet-gevonden regels blijven in het tekstvak. Twijfelgevallen krijgen een keuzelijst met andere versies.
- **Spotify-playlist overnemen** (alleen als Spotify gekoppeld is). Volgens de Spotify-documentatie van februari 2026 leest de app de nummers met `GET /playlists/{id}/items` (veld `item`, voorheen `track`), en dat werkt in Development Mode **alleen voor playlists die je zelf hebt gemaakt of waaraan je meewerkt**; voor andere playlists geeft Spotify 403. Daarvoor zijn de scopes `playlist-read-private` en `playlist-read-collaborative` nodig: wie eerder alleen voor afspelen koppelde, geeft één keer opnieuw toestemming (de app vraagt daarom). Daarna zoekt de app op de achtergrond voor elk nummer een Apple Music-fragment; een nummer zonder match speelt alleen via Spotify (als Spotify de muziekbron is) en doet anders niet mee.

**Het jaartal.** iTunes en Spotify geven vaak het jaar van een heruitgave of verzamelalbum. De app neemt het vroegste jaar onder de zoekresultaten die duidelijk dezelfde opname van dezelfde artiest zijn (geen live, remix, karaoke). Komt dat jaar alleen van een verzamelalbum of uit één bron, dan staat er **controleer het jaar**. Elk jaar is per nummer aan te passen; het jaar hoort bij de playlist.

**Minimum.** Tijdlijn vraagt minstens 3 nummers (1 startkaart per speler + 1), Bingo 3 per speler (dus 6). Met minder is de startknop uitgeschakeld en zegt de app waarom; scannen met kaartjes kan altijd. Met 30+ nummers duren potjes lang genoeg.

**Lopende potjes** bewaren een kopie van hun kaarten. Wissel je van muziek terwijl er een potje loopt, dan speelt dat potje gewoon door met de oude muziek (de app meldt dat); een nieuw potje gebruikt de nieuwe.

**Printen en scannen op elk toestel.** De printpagina print het actieve deck (kies erboven een andere playlist), met de naam van de playlist op elk vel. Een ingebouwde kaart heeft als QR `#/c/042`; een kaart van een eigen playlist `#/c/~<code>`, waarin het iTunes-id en het jaar zitten (het jaar licht versluierd, met een controleteken). Zo'n kaart speelt op elke telefoon met TimeTunesr, ook zonder die playlist: de app zoekt het nummer op id op en toont bij **Toon antwoord** het jaar uit de QR en titel en artiest uit Apple Music.

**Delen** maakt een link en een QR-code: `#/pl/<code>` met per nummer alleen iTunes-id + jaar (±10 tekens) en de naam. Het andere toestel vraagt eerst of de playlist erbij mag en haalt titels op met één lookup per 150 id's. Is de link te lang voor één QR-code (meer dan ±60 nummers), dan wordt hij over meerdere codes verdeeld (*Code 1 van 3*); elke gescande code voegt zijn deel toe aan dezelfde playlist. Boven de 8 codes is er alleen de link. **Exporteren** geeft een `.json`-back-up; **Back-up terugzetten** voegt die als nieuwe playlist toe (nooit overschrijven).

**Opslag** (localStorage): `timetunesr.playlists.v1` = `{ v: 1, lists: [{ id, name, nextN, tracks: [{ n, itunesId, spotifyId?, title, artist, album, year, yearSure, previewUrl, trackViewUrl }] }] }` en `timetunesr.activeDeck.v1` = `"builtin"` of het id van een playlist (JSON-string). `n` is het kaartnummer binnen de playlist. Een voorbeeld-playlist klaarzetten (bijv. voor de uitlegvideo), in de console of met `page.evaluate`:

```js
localStorage.setItem('timetunesr.playlists.v1', JSON.stringify({ v: 1, lists: [{ id: 'demo', name: 'Feestje', tracks: [
  { n: 1, itunesId: 6800311742, title: 'Dancing Queen', artist: 'ABBA', year: 1976 },
  { n: 2, itunesId: 1440763833, title: 'Gold Digger', artist: 'Kanye West', year: 2005 },
  { n: 3, itunesId: 1308586364, title: 'Back for Good', artist: 'Take That', year: 1995 },
  { n: 4, itunesId: 1322068804, title: 'Mambo No. 5 (A Little Bit Of...)', artist: 'Lou Bega', year: 1999 },
  { n: 5, itunesId: 268284600, title: '...Baby One More Time', artist: 'Britney Spears', year: 1998 },
  { n: 6, itunesId: 1440741632, title: 'In the Summertime', artist: 'Mungo Jerry', year: 1970 },
] }] }));
localStorage.setItem('timetunesr.activeDeck.v1', JSON.stringify('demo'));
```

Testen: `tests/unit/playlist.test.mjs`, `tests/e2e/playlists.e2e.mjs` en `playlists-spotify.e2e.mjs` (met nagebootste iTunes en Spotify). `node tests/e2e/playlists-live.e2e.mjs` is een rooktest tegen de echte iTunes-API (internet nodig; geen onderdeel van `npm run test:e2e`). `localStorage['timetunesr.itunesGap.v1'] = '30'` verkort voor tests de wachttijd tussen iTunes-verzoeken (standaard 3,1 s).

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
- Hele nummers via Spotify kan ook, maar vraagt Premium en een eenmalige koppeling; zie **Spotify koppelen**.

## Spotify koppelen

Naast de fragmenten van 30 seconden kan TimeTunesr hele nummers afspelen via Spotify. Kies dat bij **Instellingen** (`#/instellingen`).

**Wat het doet.** De app speelt niet zelf, maar bedient via de Spotify Web API de Spotify-app op de telefoon (of een speaker met Spotify Connect). Inloggen gaat met Authorization Code + PKCE, dus zonder geheime sleutel in de site. Per kaart gebruikt de app het veld `spotifyId` uit `deck.json`; ontbreekt dat, dan zoekt hij het nummer op met het account van de speler (`track:"titel" artist:"artiest"`), kiest de beste match (live-, karaoke-, cover- en remixversies worden vermeden) en onthoudt die per kaart. De speler blijft verborgen: titel, artiest en hoes uit Spotify komen nooit op het scherm. Na de gekozen afspeelduur (30 s, 60 s of het hele nummer; standaard 60 s) en bij het verlaten van het afspeelscherm pauzeert Spotify. Lukt Spotify niet (geen Premium, nummer niet gevonden, sessie verlopen), dan valt de app terug op het fragment van 30 seconden en meldt dat kort. Vindt Spotify geen apparaat, dan vraagt de app de Spotify-app te openen en een apparaat te kiezen.

**Wat de eigenaar eenmalig regelt** (de stappen staan ook in de app, onder *Zo koppel je Spotify*):

1. Maak op [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) een app aan (Premium nodig).
2. Vul bij *Redirect URIs* exact het adres in dat de app bij Instellingen toont: de app-URL zonder `#` of `?`, bijvoorbeeld `https://<gebruiker>.github.io/time-tunes/`. Spotify accepteert alleen https, of voor lokaal testen `http://127.0.0.1:<poort>/` (niet `localhost`).
3. Vink **Web API** aan en kopieer de **Client ID**. Zet die in `app/config.js` (`SPOTIFY_CLIENT_ID`) om hem voor iedereen in te vullen, of laat spelers hem zelf invullen bij Instellingen.
4. Voeg medespelers toe onder **User Management** (Development Mode: maximaal 5 accounts).

**Beperkingen.** De eigenaar en elke speler hebben Spotify Premium nodig. De Spotify-app moet op het toestel open staan (of er moet een speaker beschikbaar zijn). Op het vergrendelscherm, in meldingen en in de Spotify-app is de titel te zien: niet spieken. Een iPhone-app op het beginscherm heeft eigen opslag, dus verbind vanuit die app zelf.

**Kaarten vooraf koppelen.** `tools/link-spotify.mjs` zoekt voor alle kaarten het Spotify-nummer op met dezelfde matchregels (`app/js/spotify-match.js`) en schrijft `spotifyId` in `app/data/deck.json`. Hiervoor is ook de Client secret nodig, dus draai dit op je eigen computer en zet de secret nooit in de site:

```bash
SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node tools/link-spotify.mjs --dry-run   # alleen rapport
SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node tools/link-spotify.mjs             # deck.json bijwerken
```

Het rapport noemt twijfelgevallen en kaarten zonder match met een link om te controleren; zet zo nodig zelf een `spotifyId` in het deck. Andere opties: `--sure-only`, `--only 001,042`, `--force`, `--report rapport.json`. De tool wacht tussen verzoeken en respecteert `Retry-After` bij 429.
