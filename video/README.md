# Uitlegvideo

`timetunesr-uitleg.mp4` legt het spel uit aan iemand die het nog nooit zag: liggend 1920 × 1080, 30 fps, H.264, zonder geluid.
Links staat de echte app in een telefoonkader, rechts de ondertitel met stapnummer en een getekende tafel met kaarten.

## Opnieuw opnemen

```bash
node video/make.mjs                       # alles: camerabeelden, opname, video, nakijkbeelden
node video/make.mjs record render check   # alleen deze stappen (camerabeelden bestaan al)
```

Nodig: Node 20+, Playwright met Chromium (dezelfde als voor `npm run test:e2e`), ffmpeg in `/usr/bin/ffmpeg` (anders `FFMPEG=...`) en internet voor de fragmenten.
Staat `HTTPS_PROXY` gezet, dan gaat het verkeer van de app via die proxy. Het geheel duurt ongeveer tien minuten.

Tussenbestanden (camerafilmpjes, telefoonframes, videodelen, `events.json`, samen ongeveer 1 GB) komen in `$TT_VIDEO_TMP`, standaard `<tmp>/timetunesr-video`. Ze horen niet in de repo.

| Stap | Script | Wat het doet |
| --- | --- | --- |
| 1 | `1-camera.mjs` | Maakt per kaart een nep-camerafilmpje (MJPEG) waarin de geprinte kaart het beeld in schuift. De kaart is de printopmaak van de app zelf, met een werkende QR-code. |
| 2 | `2-record.mjs` | Start de app (`scripts/serve.mjs`), bedient hem in real time met Playwright en neemt het telefoonscherm op als verliesvrije PNG-frames (CDP-screencast). Chromium krijgt de filmpjes van stap 1 als camera. Schrijft `events.json`: wanneer elke scène begon en waar er getikt is. |
| 3 | `3-render.mjs` | Tekent het decor (`stage/`) frame voor frame, zet het juiste telefoonframe erin en stuurt de 1920 × 1080-screenshots direct naar ffmpeg (drie stukken tegelijk, daarna aan elkaar gezet). Dit is trager dan Playwrights `recordVideo`, maar scherp en precies 30 fps. |
| 4 | `4-check.mjs` | Haalt per scène een beeld uit het eindbestand en drukt de ondertitel van dat moment erbij af. Extra tijdstippen: `node video/4-check.mjs 17.5 44`. |

Eén los beeld bekijken zonder alles te renderen: `node video/3-render.mjs --still 31.5`.

## Aanpassen

- `config.mjs`: welke kaarten op tafel liggen, de namen in de digitale modus, het adres in de QR-codes (`TT_PUBLIC_URL`).
- `stage/scenes.js`: alle koppen en ondertitels. Leg ze naast `#/regels` in de app, zodat de video niets belooft wat de app niet doet.
- `2-record.mjs`: het draaiboek (volgorde, tikken, hoe lang elke scène duurt).
- `stage/stage.js` en `stage/stage.css`: het decor. Kleuren en lettertypes komen uit `app/css/app.css`; de kaartjes gebruiken de printopmaak uit `app/js/screens/print.js`.

## Goed om te weten

- De opname breekt af als een fragment niet start, als de app een fout geeft, of als titel, artiest of jaartal zichtbaar is tijdens het verborgen afspelen. Draai de stap dan opnieuw.
- Er zit geen geluid in de video: de fragmenten uit de app zijn van Apple Music en mogen niet mee.
- De digitale modus schudt met een vaste seed (de opname levert de eerste `Math.random()`-waarde aan), zodat altijd dezelfde vier kaarten langskomen en er één goede en één foute beurt te zien is. Het winnaarsscherm komt uit een klaargezette spelstand (`timetunesr.game.v1`); in beeld staat dan even "Even later…".
- De app gebruikt het systeemlettertype. Op de machine waar deze video gemaakt is, is dat Inter; op een andere machine kan de telefoon er iets anders uitzien.
- Aan `app/`, `tests/` en `tools/` verandert dit niets. De eigen pagina's worden via Playwright onder `/__video/` op de origin van de app geserveerd.
