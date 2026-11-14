# TimeTunesr

Een muziekpartyspel voor groepen: een gratis webapp plus fysieke kaarten met QR-codes.
Scan een kaart en de app speelt een fragment af, zonder titel, artiest of jaartal te tonen.
Leg de kaart op de juiste plek in je eigen tijdlijn en draai hem om: achterop staan jaar, artiest en titel.
Geen kaarten bij de hand? Kies **Speel zonder kaarten**: dan gaat één telefoon rond en houdt de app de stand bij.

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
| `app/js/screens/` | De schermen: start, scannen, kaart afspelen, digitaal spel, printen, spelregels |
| `app/vendor/` | jsQR (QR lezen, Apache-2.0) en qrcode-generator (QR maken, MIT), met licenties |
| `app/sw.js` | Service worker: app-shell offline, netwerk eerst zodat updates direct doorkomen |
| `tests/unit/` | `node --test` voor de spellogica |
| `tests/e2e/` | Playwright-scripts (kaart scannen met nep-camera, digitaal spel, printen, PWA) |

Routes (hash): `#/` start, `#/scan`, `#/c/042` (verborgen afspeelscherm voor kaart 042), `#/spel`, `#/print`, `#/regels`, `#/instellingen`.

## Kaarten printen

1. Open de app op het adres waar hij gehost wordt en kies **Kaarten printen**.
2. Controleer het adres voor de QR-codes. Standaard is dat het huidige adres van de app. Print je vanaf `localhost` maar host je op GitHub Pages? Vul dan het Pages-adres in, bijvoorbeeld `https://<gebruiker>.github.io/time-tunes/`.
3. Kies alle kaarten of een bereik en klik op **Printen**.
4. Print op A4, schaal 100%, **dubbelzijdig met spiegelen over de lange zijde**. De achterkanten zijn per rij gespiegeld, zodat elk antwoord achter de goede QR-code valt. Knip langs de stippellijnen (kaarten van 6,2 × 6,2 cm).

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
