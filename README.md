# TimeTunesr

Een muziekpartyspel voor groepen: een gratis webapp plus fysieke kaarten met QR-codes.
Scan een kaart en de app speelt een fragment af, zonder titel, artiest of jaartal te tonen.
Leg de kaart op de juiste plek in je eigen tijdlijn en draai hem om: achterop staan jaar, artiest en titel.

Er zijn twee spellen, **Tijdlijn** en **Bingo**, en drie manieren van spelen:

- **Met kaartjes**: geprinte muziekkaarten met QR-code. Scan een kaart, luister en draai hem om voor het antwoord. Voor Bingo print je daarnaast bingokaarten en kruis je af met een pen.
- **Alleen de app**: geen kaartjes nodig. Eén telefoon gaat rond; de app kiest de nummers, controleert de antwoorden en houdt de stand bij.
- **Ieder een eigen telefoon**: de spelleider maakt een kamer, de rest doet mee met een code of QR-code en antwoordt tegelijk op de eigen telefoon; zie **Samen spelen**. Daar is ook een derde spel: de **Quiz** (vier antwoorden per nummer, snelheid telt).

### Bingo

Iedere speler (2–8) heeft een eigen, willekeurige bingokaart van 3×3 (snel potje) of 4×4 (standaard). Na elk fragment claimt de speler één open vakje: een decennium (*Jaren 80*), een ruime periode (*Vóór 2000*), *Jaar ±2* (jaartal noemen, maximaal 2 jaar ernaast) of *Artiest*/*Titel* (hardop zeggen, de groep beslist). Goed = afgestempeld, fout = blijft open. Wie het eerst een volle rij, kolom of diagonaal heeft, wint; zijn de nummers op, dan wint wie de meeste vakjes heeft.

Elke kaart mengt makkelijke en moeilijke vakjes: per rij, kolom en diagonaal hoogstens één periodevakje en één *Jaar ±2*, nooit twee keer *Artiest* of *Titel*. Een 4×4-kaart heeft 4 periodes, 6 decennia, 2× ±2, 2× artiest en 2× titel; 3×3 heeft 2, 4, 1, 1, 1. Een simulatie met het echte deck (spelers die ~60% van de decennia goed hebben) geeft voor 4 spelers op 4×4 gemiddeld 8 rondes (10% binnen 6, 90% binnen 10), op 3×3 ongeveer 4.

Voorspelbaar potje (tests, uitlegvideo): zet `localStorage['timetunesr.bingoSeed.v1'] = '7'` (een geheel getal). Elk nieuw bingopotje gebruikt dan die zaaiwaarde: dezelfde kaarten en dezelfde volgorde van nummers. De lopende stand staat in `timetunesr.bingo.v1` (los van het tijdlijnspel in `timetunesr.game.v1`).

De app is een installeerbare PWA (iPhone Safari en Android Chrome) in gewone HTML, CSS en JavaScript-modules. Er is geen build-stap en er zijn geen externe diensten nodig, behalve de 30-seconden-previews van Apple Music (en voor *Samen spelen* een kleine kamerserver, zie **Server voor samen spelen**).

## Samen spelen

Met **Ieder een eigen telefoon** speelt iedereen op zijn eigen telefoon mee in één potje Bingo, Tijdlijn of Quiz.

- **Spelleider** (`#/spelleider`, startknop *Maak een kamer*): maakt een kamer met een code van 4 letters (zonder I, L en O). Dit toestel speelt de muziek (zet het op een speaker) en bedient *Onthul* en *Volgend nummer*; de kamerserver bewaart de spelstand en controleert de antwoorden. De spelleider kiest het spel (Bingo 3×3/4×4 of Tijdlijn met een doel, standaard 10) en kan zelf meespelen (keuze bij het aanmaken). Code en QR-code staan in de lobby en zijn tijdens het spel bereikbaar via de knop *QR*.
- **Spelers** (`#/kamer`, startknop *Doe mee*): vullen de code en hun naam in, of scannen de QR-code (die opent `#/kamer/ABCD`).
- **Ritme**: nummer speelt → iedereen kiest op zijn eigen kaart/tijdlijn en zet zijn antwoord vast (wijzigen mag tot de onthulling) → de spelleider tikt *Onthul* (altijd beschikbaar; licht op als iedereen die online is heeft geantwoord) → antwoord, wie goed zat en tussenstand → *Volgend nummer*. Bij Bingo claimt iedereen per nummer één open vakje of past; een getypte artiest of titel keurt de spelleider-app tolerant (hoofdletters, accenten, lidwoorden, haakjes, *feat.*, *en*/*&* en kleine typefouten tellen niet; een ander getal wel) en de spelleider kan elk oordeel met één tik omdraaien. Wie in dezelfde ronde een volle lijn of het doel haalt, deelt de winst. *Nog een potje* speelt met dezelfde spelers.
- **Niet spieken**: titel, artiest en jaar van het lopende nummer gaan pas bij de onthulling naar de spelers. Daarvoor staat het nummer niet in hun scherm en niet in de berichten die ze krijgen; elke speler krijgt alleen zijn eigen kaart of tijdlijn. Antwoorden worden op de server gecontroleerd. Het lopende nummer gaat vóór de onthulling alleen naar het toestel dat de muziek speelt; spelers krijgen nooit een preview-link.
- **Robuust**: elke telefoon heeft een vast speler-id (localStorage) en komt na herladen of ontwaken vanzelf terug in hetzelfde potje met zijn eigen kaart en antwoord. Verbindingen herstellen zich met oplopende wachttijd, meteen opnieuw bij terugkeer naar de app, en met een hartslag elke 4 s (13 s stil = offline). De spelleider ziet wie offline is, wacht nooit op iemand en kan spelers verwijderen. Herlaadt de spelleider, dan komt dezelfde kamer met dezelfde code en stand terug. Wie halverwege instapt, begint zo ver als de speler die het verst achter ligt (Bingo: zoveel gratis vakjes, nooit meer dan 2 in één lijn; Tijdlijn: zoveel kaarten). Een app met een ander protocolversienummer krijgt een nette melding.
- **De kamer overleeft de spelleider** (met server): gaat diens telefoon op slot of naar de achtergrond, dan blijven de spelers verbonden, kunnen nieuwe spelers gewoon meedoen en zien ze *De spelleider is even weg*. Komt hij terug, dan gaat het spel verder. Is hij 30 s weg, dan kan een speler op *Neem de leiding over* tikken: de muziek speelt dan op diens telefoon (die blijft ook gewoon meespelen). De spelleider kan de leiding later met *Neem de leiding terug* weer pakken. Een plek in de kamer is beschermd met een geheim token dat de server uitgeeft (localStorage), zodat niemand andermans kaart kan overnemen.
- **Nooit eindeloos "verbinden…"** (met server): na een paar seconden ziet iedereen per stap wat lukt en wat niet (*Server bereikt*, *Kamer gevonden*, *In de kamer*), met in gewone woorden wat te doen, en de knop *Kopieer diagnose* (app-versie, browser, serveradres, per stap ok/fout met foutcode en duur; geen namen). Slaapt de server (gratis Render), dan staat er *Server wordt wakker…* met een voortgangsbalk; het startscherm maakt hem alvast wakker.
- **Quiz** (alleen met server; derde spel in de lobby, testid `room-game-quiz`): een muziekquiz voor een verjaardag. De spelleider kiest zijn muziek zoals altijd (het actieve deck of een eigen playlist), het aantal vragen (10, 15 of 20, nooit meer dan er nummers zijn), de soort vragen (*Mix*, *Jaar*, *Artiest* of *Titel*; standaard Mix: om de beurt) en de bedenktijd (15, 20 of 30 s; standaard 20).
  - Per vraag speelt het nummer verborgen bij de spelleider; elke telefoon krijgt *Uit welk jaar is dit nummer?* (het goede jaar plus drie geloofwaardige: één 1–3 jaar ernaast, één 4–8, één 9–15; nooit dubbel, nooit in de toekomst), *Wie is de artiest?* of *Hoe heet dit nummer?* (het goede plus drie andere uit dezelfde muziek, zo mogelijk uit dezelfde periode, geen dubbele en geen nummer van dezelfde artiest). Staan er minder dan vier verschillende artiesten of titels in de muziek, dan worden dat jaarvragen (de lobby zegt dat). De server maakt de vragen (met de zaaiwaarde van het potje) en de volgorde van de antwoorden; welk antwoord goed is, gaat pas bij de onthulling naar de telefoons.
  - **Klok**: de bedenktijd begint op de server zodra de telefoon van de spelleider meldt dat de muziek speelt (komt die melding niet, dan na 6 s toch). Elke telefoon toont de tijd in servertijd (gecorrigeerd voor een verkeerd lopende klok). Eén antwoord per speler, niet te wijzigen; na de tijd (plus 0,8 s voor het netwerk) telt een antwoord niet meer. De vraag sluit als iedereen die online is heeft geantwoord, als de tijd om is (Node: een timer; Cloudflare: het Durable Object-alarm, dat ook na hibernation afgaat), of als de spelleider op *Onthul* tikt.
  - **Punten**: goed = 500 plus tot 500 voor snelheid (lineair over de bedenktijd), plus 50 per eerdere goede vraag op rij (hooguit 200); fout of geen antwoord = 0. Gelijke punten = gedeelde plek.
  - **Onthulling**: het goede antwoord groot, hoeveel spelers elk antwoord kozen, de tussenstand (met ▲ bij wie gestegen is) en op elke telefoon goed/fout, de verdiende punten en de eigen plek. Na de laatste vraag: podium (top 3) en de eindstand, met *Nog een quiz* of *Ander spel kiezen*.
  - Het scherm van de spelleider werkt ook op een laptop of tv (vanaf 900 px breed: vraag, antwoorden, klok, *x van y hebben geantwoord* en ranglijst groot leesbaar). Speelt de spelleider mee, dan staan zijn eigen antwoordknoppen onder de bediening.
  - Verder als bij de andere spellen: wie later instapt begint op 0, de vraag wacht niet op wie wegvalt, herladen brengt je terug in dezelfde vraag met de resterende tijd en je antwoord, de leiding overnemen kan, en na een herstart van een Node-server begint de lopende vraag opnieuw (volle bedenktijd zodra de muziek weer speelt; iedereen antwoordt opnieuw). Op Cloudflare loopt de vraag na een herstart gewoon door.
  - Bij de PeerJS-noodroute (zonder server) is de quiz niet te kiezen; de app zegt dat hij de server nodig heeft.

**Zonder server (noodroute): PeerJS.** Is er geen server ingesteld (`MULTI_SERVER_URL` leeg, of per browser `localStorage['timetunesr.multiServer.v1'] = '"off"'`), dan werkt het zoals vroeger: de telefoon van de spelleider houdt de stand bij en de telefoons vinden elkaar via een PeerJS-signaleringsserver ("broker"); daarna lopen de berichten rechtstreeks tussen de telefoons via WebRTC-datakanalen (stervorm: elke speler praat alleen met de spelleider). Standaard is dat de **gratis openbare broker `0.peerjs.com`** met de STUN/TURN-servers die PeerJS standaard meegeeft. Die dienst heeft geen garanties: als hij plat ligt of traag is, lukt meedoen niet of pas na een tijdje. Op hetzelfde wifi verbinden telefoons meestal rechtstreeks; via 4G of streng afgeschermde netwerken is soms TURN nodig. Peer-id van de spelleider: `timetunesr-kamer-<code>`. Op echte telefoons bleef meedoen zo soms hangen; daarom is de server nu de standaard en meldt de app bij deze route eerlijk dat het op sommige netwerken niet lukt.

**Eigen broker.** Draai op een eigen server de npm-module `peer` (`npx peerjs --port 9000`, achter https) en vul in `app/config.js` `MULTI_SIGNAL` in (`host`, `port`, `path`, `secure`, `key`). Eigen STUN/TURN-servers gaan in `MULTI_ICE_SERVERS` (bv. `[{ urls: 'turn:turn.example.nl:3478', username: '…', credential: '…' }]`). Om iets uit te proberen zonder de code te wijzigen kan het ook per browser: `localStorage['timetunesr.multiSignal.v1'] = '{"host":"…","port":443,"path":"/","secure":true,"key":"peerjs"}'`.

**Code**: `app/js/multi/` (pure spelmachine `game.js`, quizregels `quiz.js`, berichtprotocol `protocol.js`, tolerante antwoordvergelijking `match.js`, kamercodes `code.js`, serverberichten `server-protocol.js`; daarnaast `server-session.js` voor de serverroute en `transport.js`, `host-session.js`, `client-session.js` voor PeerJS), schermen `app/js/screens/room-*.js`, opmaak `app/css/multi.css`, PeerJS in `app/vendor/`, de server in `server/`. Opslag: speler `timetunesr.multiPlayerId.v1` en `timetunesr.multiJoin.v1`; met server `timetunesr.multiTokens.v1` (tokens per kamer), `timetunesr.multiServerHost.v1` (de kamer die dit toestel leidt) en `timetunesr.multiServerBackup.v1` (kopie van de kamer bij de spelleider, zie hieronder); zonder server `timetunesr.multiHost.v1`.

**Testen en voorspelbaar potje.** `npm run test:e2e` laat een spelleider en meerdere telefoons (aparte browsercontexten) samen spelen, één keer via een lokale PeerJS-broker (devDependency `peer`; suites `multi`, `multi-playlist`) en één keer via de Node-kamerserver (`multi-server`, `multi-server-playlist`: winst in Bingo en Tijdlijn, herladen, spelleider weg terwijl iemand meedoet, leiding overnemen, server-herstart, onbereikbare server en verkeerde code met diagnose, lekcontrole) en `multi-quiz` (een hele quiz van 10 vragen met spelleider die meespeelt, eigen playlist, snel/langzaam/fout/geen antwoord, timer, herladen, laat instappen, podium, breedbeeld 1280×720). Zie `tests/e2e/multi-helpers.mjs` (`startSignal`, `startRoomServer`, `phone`, `createRoom`, `joinRoom`, `waitForPlayers`); `phone(browser, signal)` gebruikt altijd de PeerJS-route, `phone(browser, roomServer)` de server. `npm run test:e2e:cf` draait de Cloudflare-versie lokaal met `wrangler dev` (rooktest, ook met een korte quiz: een vraag die door het alarm sluit en een herstart midden in een vraag). Met `localStorage['timetunesr.multiSeed.v1'] = '7'` op het toestel van de spelleider krijgt elk potje dezelfde kaarten en dezelfde volgorde van nummers. `npm run test:e2e:public` doet één ronde via de echte openbare broker.

## Server voor samen spelen

Bij *Samen spelen* is een kleine server de baas over de kamer: hij maakt de kamercode, houdt de stand bij, controleert de antwoorden en stuurt elke telefoon alleen wat die mag zien. Alle telefoons (ook die van de spelleider) maken alleen een gewone verbinding naar die server. Dezelfde spelregels als in de app (`app/js/multi/game.js`) draaien op de server; er is geen kopie.

Het adres van de server staat in `app/config.js` bij `MULTI_SERVER_URL`. Standaard is dat **`https://time-tunes.jaccotlam.workers.dev`**.

### Cloudflare (de standaard, al gekoppeld)

De repository is in Cloudflare gekoppeld aan de Worker **time-tunes** (Workers Builds). Bij elke push bouwt Cloudflare de branch en voert `npm clean-install` en `npx wrangler deploy` uit. Het bestand `wrangler.jsonc` in de hoofdmap vertelt wat er dan online komt: **één Worker die zowel de app (map `app/`) als de kamerserver (`server/worker.mjs`) serveert**, op `https://time-tunes.jaccotlam.workers.dev`. Elke kamer is een *Durable Object* met eigen opslag, dus een kamer overleeft een herstart of een nieuwe versie.

**Wat jij moet doen:** niets, behalve pushen en wachten tot de build klaar is (Cloudflare-dashboard → **Workers & Pages → time-tunes → Deployments**; een build duurt een paar minuten). Controleren: open `https://time-tunes.jaccotlam.workers.dev/health`; daar moet `{"ok":true,…}` staan. De app werkt daarna op dat adres en ook gewoon op GitHub Pages (`https://jaccotlam.github.io/time-tunes/`), want beide adressen staan in de lijst toegestane adressen.

Houd de naam `time-tunes` in `wrangler.jsonc` gelijk aan de naam van de Worker in het dashboard, anders mislukt de build. Moet de koppeling ooit opnieuw: dashboard → **Workers & Pages → Create application → GitHub**, kies de repository, laat *Root directory* leeg (de hoofdmap) en de commando's op hun standaard. Er zijn geen sleutels in GitHub nodig.

**Kosten:** het gratis Workers-plan is genoeg voor gezelschapsspellen ([prijzen Workers](https://developers.cloudflare.com/workers/platform/pricing/), [prijzen Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)): 100.000 verzoeken per dag (de app zelf laden is gratis en telt niet mee), Durable Objects alleen met SQLite-opslag (dat gebruiken we), 5 GB opslag. Een speelbericht telt als 1/20 verzoek en de hartslag die de verbinding openhoudt telt niet. Een avond met tien telefoons kost hooguit een paar duizend van die 100.000. De Cloudflare-server **slaapt niet**: verbinden gaat altijd direct. Worden de grenzen ooit overschreden, dan weigert Cloudflare tot 00:00 UTC (01:00 of 02:00 Nederlandse tijd) nieuwe verzoeken; je betaalt niets ongemerkt.

**Toegestane adressen** staan in `wrangler.jsonc` bij `ALLOWED_ORIGINS` (komma's ertussen, `:*` = elke poort). Een andere site die de server wil gebruiken, wordt geweigerd.

### Render (alternatief)

Wil je de server liever ergens anders: `server/node.mjs` is dezelfde server voor elke Node-host (Node 20+, pakket `ws`). Voor Render staat er een Blueprint klaar (`render.yaml`):

1. Maak een account op [render.com](https://render.com) en koppel GitHub.
2. Kies **New → Blueprint**, kies deze repository en de branch, en klik **Apply**. Render maakt de gratis web service *timetunesr-kamers*.
3. Na de eerste build staat bovenaan het adres, bijvoorbeeld `https://timetunesr-kamers.onrender.com`. Controleer `…/health`.
4. Zet dat adres in `app/config.js` bij `MULTI_SERVER_URL` (of geef het door, dan doe ik het).

**Kosten en grenzen** ([Render gratis](https://render.com/docs/free)): gratis, 750 uur per maand. Een gratis service **valt in slaap na 15 minuten zonder verkeer**; de eerste verbinding daarna duurt tot ongeveer een minuut (de app toont *Server wordt wakker…* en maakt hem al wakker zodra het startscherm opent; tijdens een potje houden de telefoons hem wakker). Render kan een gratis service ook zomaar herstarten; dan is de kamer even weg uit het geheugen. De telefoon van de spelleider heeft daarom een kopie van de kamer (zonder geheimen van andere spelers) en zet die vanzelf terug zodra hij weer verbinding heeft; spelers wachten zolang met *Kamer is even weg*.

### Hoe het werkt (voor ontwikkelaars)

- `server/room.mjs`: één kamer, los van het transport (spelregels uit `game.js`, weergaven uit `protocol.js`). `server/policy.mjs`: routes, toegestane adressen (CORS), limieten. `server/core.mjs`: alle kamers in het geheugen (Node). `server/node.mjs`: Node-adapter (`http` + `ws`, `PORT`, `HOST`, `ALLOWED_ORIGINS`). `server/worker.mjs`: Cloudflare-adapter (Worker + Durable Object `Room` met hibernatable WebSockets en de stand in Durable Object-opslag).
- HTTP: `GET /health`, `POST /rooms` (nieuwe kamer → code + token van de spelleider), `GET /rooms/CODE` (bestaat de kamer?), `POST /rooms/CODE/restore` (kamer terugzetten na herstart, alleen met het token van de spelleider), WebSocket `GET /rooms/CODE/ws`. Berichten: `app/js/multi/server-protocol.js` (protocolversie 2, sinds de quiz: `playing`, quiz-instellingen, het quizdeel van de weergave, `meta.now`). Een app met een andere versie krijgt een nette melding (*ververs de pagina*, of bij een nieuwere app dan de server *probeer het over een paar minuten opnieuw*); opgeslagen kamers blijven werken. Platte tekst `ping`/`pong` elke 10 s; 25 s stil = verbinding dood.
- Limieten: 12 spelers per kamer, 40 verbindingen per kamer, berichten tot 16 kB (het deck bij de start tot 512 kB, max. 2000 kaarten), 80 berichten per 10 s per verbinding, 30 nieuwe kamers per 10 minuten per IP-adres, 1000 kamers tegelijk (Node). Een kamer verloopt na 6 uur zonder activiteit (een nooit gebruikte kamer na 30 minuten).
- Tokens staan op de server alleen als SHA-256-hash. Spelers krijgen nooit de lijst nummers; de muziektelefoon krijgt alleen het lopende nummer.
- Lokaal: `npm run server` (Node, poort 8787), of `npx wrangler dev` (app + server samen via workerd op http://127.0.0.1:8787). Zet dan in de browser `localStorage['timetunesr.multiServer.v1'] = '"http://127.0.0.1:8787"'`, anders praat de app met de echte server uit `app/config.js`.

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
| `app/js/multi/` | *Samen spelen*: spelmachine, protocol, antwoordvergelijking, kamercodes, verbinding (server of PeerJS) |
| `server/`, `wrangler.jsonc`, `render.yaml` | De kamerserver voor *Samen spelen* (Cloudflare Worker + Durable Objects, of Node) |
| `app/js/bingo.js` | Pure bingologica zonder DOM: kaarten genereren (zaaibare RNG), claims controleren, lijn en winnaar bepalen |
| `app/js/screens/` | De schermen: start, scannen, kaart afspelen, Tijdlijn (digitaal), Bingo, printen, spelregels |
| `app/css/bingo.css` | Opmaak van het bingospel en de printbare bingokaarten |
| `app/js/playlist-logic.js`, `playlists.js`, `itunes.js`, `spotify-playlists.js`, `screens/playlist*.js`, `css/playlists.css` | Eigen playlists: pure logica (regels, jaarkeuze, QR- en deelcodes), opslag, iTunes-zoeken, Spotify-import, schermen |
| `app/vendor/` | jsQR (QR lezen, Apache-2.0) en qrcode-generator (QR maken, MIT), met licenties |
| `app/sw.js` | Service worker: app-shell offline, netwerk eerst zodat updates direct doorkomen |
| `tests/unit/` | `node --test` voor de spellogica |
| `tests/e2e/` | Playwright-scripts (kaart scannen met nep-camera, Tijdlijn, Bingo, printen, PWA) |

Routes (hash): `#/` start, `#/scan`, `#/c/042` (verborgen afspeelscherm voor kaart 042), `#/c/~<code>` (kaart van een eigen playlist), `#/spel` (Tijdlijn), `#/bingo`, `#/print` (of `#/print/<playlist-id>`), `#/regels`, `#/instellingen`, `#/playlists` (muziek kiezen), `#/playlists/<id>` (een playlist bewerken), `#/pl/<code>` (gedeelde playlist ontvangen), `#/spelleider` en `#/kamer/ABCD` (samen spelen).

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
