// "Spotify koppelen" with an OWN Client ID, on a phone (390 px), against a fake Spotify that
// behaves like the real one where it matters (its own error page for a wrong Client ID or
// Redirect URI, ?error=access_denied, 403 for accounts not on User Management, Premium).
// Covers: the whole setup help from the intro to "Klaar" (copying the Redirect URI, pasting a
// Client ID with spaces, interrupting and resuming, the test sound), every typical error with
// the right explanation and the right step, sharing the setting via a link with a clean
// browser that then connects, and no horizontal scrolling at 390 px on any step.
import { join } from 'node:path';
import { launch, phoneContext, startServer, assert, OUT } from './helpers.mjs';
import { fakeSpotify, CLIENT_ID, DECK_JSON, WAV } from './spotify.e2e.mjs';

const OTHER = 'https://jaccotlam.github.io/time-tunes/';

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, animations: 'disabled' });
}

async function phone(browser, base, fake, { clipboard = true } = {}) {
  const ctx = await phoneContext(browser);
  if (clipboard) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.replace(/\/$/, '') });
  await ctx.route('**/data/deck.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: DECK_JSON }));
  await ctx.route('https://itunes.apple.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"resultCount":0,"results":[]}' }));
  await ctx.route('https://audio-ssl.itunes.apple.com/**', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
  await ctx.route('https://developer.spotify.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Dashboard</title><h1>Spotify for Developers (nep)</h1>' }));
  await fake.install(ctx);
  await ctx.addInitScript(([urls]) => {
    try { if (!localStorage.getItem('timetunesr.spotifyAppUrls.v1')) localStorage.setItem('timetunesr.spotifyAppUrls.v1', JSON.stringify(urls)); } catch { /* ignore */ }
  }, [[fake.base, OTHER]]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

const view = (page) => page.getByTestId('spotify-block').getAttribute('data-view');
async function atStep(page, step) {
  await page.locator(`[data-testid="spotify-block"][data-view="wizard-${step}"]`).waitFor({ timeout: 10000 });
}
async function noSideScroll(page, label) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert(w <= 390, `${label}: fits 390 px (no sideways scrolling, ${w})`);
}
const clip = (page) => page.evaluate(() => navigator.clipboard.readText());
const errorCode = (page) => page.getByTestId('spotify-error').getAttribute('data-code');
const store = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key);

export default async function run() {
  const port = 8400 + Math.floor(Math.random() * 90);
  const server = await startServer(port);
  const base = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  const mk = () => { const f = fakeSpotify(base); f.base = base; return f; };
  try {
    // ================= the whole setup help, from the intro to "Klaar" =================
    const fake = mk();
    const { ctx, page, errors } = await phone(browser, base, fake);
    await page.goto(`${base}#/instellingen/spotify`);
    await atStep(page, 'intro');
    const intro = await page.getByTestId('wiz-intro').textContent();
    assert(/hele nummers/.test(intro) && /Spotify Premium/.test(intro) && /±5 minuten/.test(intro) && /fragmenten/.test(intro), 'intro: what it gives, what you need (Premium, ±5 minutes, once), and that fragments work without it');
    assert(await page.getByTestId('source-preview').isChecked(), 'fragments stay the default');
    await noSideScroll(page, 'intro');
    await shot(page, 'setup-00-intro');

    await page.getByTestId('wiz-start').click();
    await atStep(page, 'dashboard');
    assert(await page.getByTestId('wiz-progress').textContent() === 'Stap 1 van 5', 'progress: "Stap 1 van 5"');
    assert(/nieuw tabblad/.test(await page.getByTestId('wiz-come-back').textContent()), 'warns: the dashboard opens in a new tab, come back to this one');
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.getByTestId('wiz-open-dashboard').click()]);
    await popup.waitForLoadState();
    assert(popup.url() === 'https://developer.spotify.com/dashboard', `the button opens the Spotify dashboard in a new tab (${popup.url()})`);
    await popup.close();
    await page.getByTestId('wiz-opened').waitFor();
    await noSideScroll(page, 'step 1');
    await shot(page, 'setup-01-dashboard');

    await page.getByTestId('wiz-next').click();
    await atStep(page, 'app');
    assert(await page.getByTestId('wiz-progress').textContent() === 'Stap 2 van 5', 'progress: "Stap 2 van 5"');
    const form = await page.getByTestId('wiz-form').textContent();
    for (const f of ['“App name”', '“App description”', '“Website”', '“Redirect URIs”', '“Which API/SDKs are you planning to use?”', 'Web API', 'Save']) assert(form.includes(f), `the form sketch names Spotify's own field ${f}`);
    assert(await page.getByTestId('spotify-redirect-uri').textContent() === base, `Redirect URI shown big: ${base}`);
    await page.getByTestId('copy-redirect-uri').click();
    await page.locator('[data-testid="copy-redirect-uri"][data-copied="true"]').waitFor();
    assert(await clip(page) === base, 'one tap copies the Redirect URI (exact app address without hash or query)');
    assert(/Gekopieerd/.test(await page.getByTestId('copy-redirect-uri').textContent()), 'with a visible confirmation');
    await page.getByTestId('wiz-copy-name').click();
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === 'TimeTunesr');
    assert(true, 'copy button for the app name');
    assert((await page.getByTestId('wiz-uri-list').textContent()).includes(OTHER), 'the other address of the site is shown too (to register both)');
    await page.getByTestId('wiz-copy-uri-1').click();
    await page.waitForFunction(async (u) => (await navigator.clipboard.readText()) === u, OTHER);
    assert(true, 'and has its own copy button');
    await noSideScroll(page, 'step 2');
    await shot(page, 'setup-02-app');

    // --- interrupt: leave the app, come back later ---
    await page.getByTestId('wiz-later').click();
    await page.getByTestId('screen-start').waitFor();
    await page.evaluate(() => { const k = 'timetunesr.spotify.setup.v1'; const s = JSON.parse(localStorage.getItem(k)); s.at -= 3600e3; localStorage.setItem(k, JSON.stringify(s)); });
    await page.reload();
    await page.goto(`${base}#/instellingen`);
    await atStep(page, 'app');
    await page.getByTestId('wiz-resumed').waitFor();
    assert(true, 'interrupted and resumed: back on step 2, "Je gaat verder waar je gebleven was"');
    await shot(page, 'setup-03-resumed');

    await page.getByTestId('wiz-next').click();
    await atStep(page, 'clientid');
    assert(await page.getByTestId('wiz-progress').textContent() === 'Stap 3 van 5', 'progress: "Stap 3 van 5"');
    assert(/Client secret/.test(await page.getByTestId('wiz-secret-note').textContent()), 'explains: the Client ID, not the Client secret');
    await page.getByTestId('spotify-client-id').fill('0123456789abcdef0123456789abcdeZ');
    assert(/0-9 en de letters a-f/.test(await page.getByTestId('client-msg').textContent()), 'a wrong character: clear message right away');
    assert(await page.getByTestId('spotify-client-save').isDisabled(), 'and "verder" stays disabled');
    await shot(page, 'setup-04-clientid-wrong');
    await page.getByTestId('spotify-client-id').fill('');
    await page.evaluate(() => navigator.clipboard.writeText('  0123 4567 89ab cdef\n0123 4567 89AB CDEF \n'));
    await page.getByTestId('wiz-paste').click();
    await page.locator('[data-testid="client-msg"][data-ok="true"]').waitFor();
    assert(await page.getByTestId('spotify-client-id').inputValue() === CLIENT_ID, 'paste button: spaces and line breaks cut away');
    await noSideScroll(page, 'step 3');
    await shot(page, 'setup-05-clientid-ok');
    await page.getByTestId('spotify-client-save').click();
    await atStep(page, 'users');
    assert(await store(page, 'timetunesr.spotify.clientId.v1') === CLIENT_ID, 'Client ID saved on this phone');
    assert(await page.getByTestId('wiz-progress').textContent() === 'Stap 4 van 5', 'progress: "Stap 4 van 5"');
    const users = await page.getByTestId('wiz-users').textContent();
    assert(/User Management/.test(users) && /5 accounts/.test(users), 'step "Medespelers toevoegen": User Management, at most 5');
    await noSideScroll(page, 'step 4');
    await shot(page, 'setup-06-users');
    await page.getByTestId('wiz-skip').click();
    await atStep(page, 'connect');
    assert(await page.getByTestId('wiz-progress').textContent() === 'Stap 5 van 5', 'the step can be skipped: "Stap 5 van 5"');
    assert(/INVALID_CLIENT/.test(await page.getByTestId('wiz-invalid-hint').textContent()), 'before logging in: what to do when Spotify shows "INVALID_CLIENT"');
    assert(/beginscherm en Safari/.test(await page.getByTestId('wiz-ios-note').textContent()), 'the iPhone case: home screen app and Safari have separate storage');
    await noSideScroll(page, 'step 5');
    await shot(page, 'setup-07-connect');

    await page.getByTestId('spotify-connect').click();
    await page.locator('[data-testid="spotify-block"][data-connected="true"]').waitFor();
    await page.locator('[data-testid="wiz-check-device"][data-ok="true"]').waitFor();
    assert(await page.getByTestId('wiz-check-account').getAttribute('data-ok') === 'true' && /Anna Test/.test(await page.getByTestId('wiz-check-account').textContent()), 'checked: connected ✓ (as Anna Test)');
    assert(/Pixel van Anna/.test(await page.getByTestId('wiz-check-device').textContent()), 'checked: playing device found ✓');
    assert(await page.getByTestId('wiz-finish').count() === 0, 'not finished before the test sound');
    await shot(page, 'setup-08-checks');
    await page.getByTestId('spotify-test').click();
    await page.locator('[data-testid="wiz-check-sound"][data-ok="true"]').waitFor();
    assert(fake.m.playing?.uri === 'spotify:track:0FurEliseTestTrack0000' && fake.m.playing.isPlaying, 'test sound ✓: Spotify plays on the phone');
    await noSideScroll(page, 'checks');
    await shot(page, 'setup-09-checks-ok');
    await page.getByTestId('wiz-finish').click();
    await page.getByTestId('wiz-done').waitFor();
    assert(/Klaar — Spotify is nu je muziekbron/.test(await page.getByTestId('wiz-done').textContent()), '"Klaar — Spotify is nu je muziekbron"');
    assert(await page.getByTestId('source-spotify').isChecked(), 'the source is Spotify now');
    await shot(page, 'setup-10-done');
    await page.getByTestId('wiz-back-preview').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="source-preview"]').checked);
    assert(true, 'one tap back to the fragments');
    await page.getByTestId('wiz-close').click();
    await page.locator('[data-testid="spotify-block"][data-view="overview"]').waitFor();
    for (const id of ['spotify-status', 'spotify-source-line', 'limit-60', 'spotify-share-open', 'spotify-redo', 'spotify-disconnect']) assert(await page.getByTestId(id).count() === 1, `compact overview for who is connected: ${id}`);
    await page.getByTestId('spotify-use').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="source-spotify"]').checked);
    await noSideScroll(page, 'overview');
    await shot(page, 'setup-11-overview');
    // after a reload the overview stays (the help is finished)
    await page.reload();
    await page.locator('[data-testid="spotify-block"][data-view="overview"]').waitFor();
    assert(true, 'after a reload: the overview, not the help');

    // ================= share with the regular group =================
    await page.getByTestId('spotify-share-open').click();
    await page.getByTestId('spotify-share-sheet').waitFor();
    const link = await page.getByTestId('spotify-share-link').inputValue();
    assert(link === `${base}#/spotify-delen/${CLIENT_ID}?van=Anna%20Test`, `share link with the Client ID and the name (${link})`);
    assert(await page.locator('[data-testid="spotify-share-qr"] svg.qr').count() === 1, 'and a QR code');
    assert(/User Management/.test(await page.getByTestId('spotify-share-users').textContent()), 'honest: friends must be on "User Management" (max 5)');
    await page.getByTestId('spotify-share-copy').click();
    await page.waitForFunction(async (l) => (await navigator.clipboard.readText()) === l, link);
    assert(true, 'link copied');
    await shot(page, 'setup-12-share');
    await page.getByTestId('spotify-share-close').click();
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);

    // the friend: a clean browser
    const friendFake = mk();
    friendFake.m.name = 'Bram';
    const friend = await phone(browser, base, friendFake);
    const F = friend.page;
    await F.goto(link);
    await F.getByTestId('screen-spotify-share').waitFor();
    assert(/Anna Test/.test(await F.getByTestId('spotify-share-from').textContent()), 'friend: "Anna Test deelt een Spotify-instelling met je"');
    assert(/User Management/.test(await F.getByTestId('spotify-share-users-note').textContent()), 'friend: told that Anna must add the account');
    await noSideScroll(F, 'share confirm');
    await shot(F, 'setup-13-share-receive');
    await F.getByTestId('spotify-share-accept').click();
    await atStep(F, 'connect');
    assert(await F.getByTestId('wiz-head').textContent().then((t) => /Nog één stap/.test(t)), 'friend: only one step left ("Nog één stap")');
    assert(await store(F, 'timetunesr.spotify.clientId.v1') === CLIENT_ID, 'friend: the Client ID is taken over');
    await shot(F, 'setup-14-share-connect');
    await F.getByTestId('spotify-connect').click();
    await F.locator('[data-testid="wiz-check-device"][data-ok="true"]').waitFor();
    assert(friendFake.last('authorize').params.client_id === CLIENT_ID, 'friend logs in with the shared Client ID');
    await F.getByTestId('spotify-test').click();
    await F.getByTestId('wiz-finish').click();
    await F.getByTestId('wiz-done').waitFor();
    assert(true, 'friend: connected and done, only by logging in');
    // the friend's account not on Anna's list: the explanation names Anna, no detour through the dashboard steps
    await F.getByTestId('wiz-close').click();
    await F.getByTestId('spotify-disconnect').click();
    await F.evaluate(() => localStorage.setItem('timetunesr.spotify.setup.v1', JSON.stringify({ step: 'connect', mode: 'shared', from: 'Anna Test', at: Date.now() })));
    await F.reload();
    friendFake.m.notAllowed = true;
    await F.getByTestId('spotify-connect').click();
    await F.getByTestId('spotify-error').waitFor();
    assert(await errorCode(F) === 'not-allowed' && /Vraag Anna Test/.test(await F.getByTestId('spotify-error').textContent()), 'friend not admitted: "Vraag Anna Test om jouw Spotify-account toe te voegen"');
    await shot(F, 'setup-15-share-not-allowed');
    assert(friend.errors.length === 0, `friend: no page errors (${friend.errors.join('; ')})`);
    // declining a share link changes nothing
    const other = await phone(browser, base, mk());
    await other.page.goto(link);
    await other.page.getByTestId('spotify-share-decline').click();
    await other.page.getByTestId('screen-start').waitFor();
    assert(await store(other.page, 'timetunesr.spotify.clientId.v1') === null, 'declined: nothing stored');
    await other.page.goto(`${base}#/spotify-delen/123`);
    await other.page.getByTestId('spotify-share-own').waitFor();
    assert(true, 'a broken share link: explained, with a way to the setup help');
    await other.ctx.close();
    await friend.ctx.close();
    await ctx.close();

    // ================= every typical error: the right explanation and the right step =================
    const E = mk();
    const e = await phone(browser, base, E);
    const P = e.page;
    const toConnect = async () => {
      await P.evaluate((cid) => {
        localStorage.setItem('timetunesr.spotify.clientId.v1', JSON.stringify(cid));
        localStorage.setItem('timetunesr.spotify.setup.v1', JSON.stringify({ step: 'connect', mode: 'own', at: Date.now() }));
        localStorage.removeItem('timetunesr.spotify.token.v1');
      }, CLIENT_ID);
      await P.goto(`${base}#/instellingen/spotify`);
      await P.reload();
      await atStep(P, 'connect');
    };
    await P.goto(base);

    // 1. Redirect URI not registered: Spotify's own page, never back; the app notices afterwards
    await toConnect();
    E.m.redirects = [OTHER];
    await P.getByTestId('spotify-connect').click();
    await P.getByTestId('fake-spotify-error').waitFor();
    assert(/Invalid redirect URI/.test(await P.getByTestId('fake-spotify-error').textContent()), 'redirect URI not registered: Spotify shows "INVALID_CLIENT: Invalid redirect URI" and stays there');
    await P.goBack();
    await P.getByTestId('wiz-unfinished').waitFor();
    assert(true, 'back in the app: "Je vorige inlogpoging is niet afgerond"');
    await noSideScroll(P, 'unfinished login');
    await shot(P, 'setup-20-unfinished');
    await P.getByTestId('wiz-unfinished-redirect').click();
    await atStep(P, 'app');
    assert(true, '"Invalid redirect URI" -> step 2, the address to copy');
    E.m.redirects = [base];

    // 2. unknown Client ID
    await toConnect();
    E.m.clientIds = ['ffffffffffffffffffffffffffffffff'];
    await P.getByTestId('spotify-connect').click();
    await P.getByTestId('fake-spotify-error').waitFor();
    assert(/Invalid client/.test(await P.getByTestId('fake-spotify-error').textContent()), 'wrong Client ID: "INVALID_CLIENT: Invalid client"');
    await P.goBack();
    await P.getByTestId('wiz-unfinished-client').click();
    await atStep(P, 'clientid');
    assert(await P.getByTestId('spotify-client-id').inputValue() === CLIENT_ID, '"Invalid client" -> step 3, with the Client ID to check');
    E.m.clientIds = [CLIENT_ID];

    // 2b. "Iets anders": just try again
    await toConnect();
    await P.evaluate(() => localStorage.setItem('timetunesr.spotify.pending.v1', JSON.stringify({ state: 'x', verifier: 'y', clientId: 'z', redirectUri: 'u', returnHash: '#/instellingen', at: Date.now() })));
    await P.reload();
    await P.getByTestId('wiz-unfinished-retry').click();
    assert(await P.getByTestId('wiz-unfinished').count() === 0 && await P.getByTestId('spotify-connect').isVisible(), '"Iets anders, of ik ging zelf terug": the notice goes, log in again');

    // 3. permission refused
    E.m.deny = true;
    await P.getByTestId('spotify-connect').click();
    await P.getByTestId('spotify-error').waitFor();
    assert(await errorCode(P) === 'denied' && /Akkoord/.test(await P.getByTestId('spotify-error').textContent()), 'permission refused: explained, try again and tap "Akkoord"');
    await shot(P, 'setup-21-denied');
    assert(await P.getByTestId('wiz-error-go').count() === 0 && await P.getByTestId('spotify-connect').isVisible() && await view(P) === 'wizard-connect', 'the one thing to do is right below: log in again');
    E.m.deny = false;

    // 4. account not under User Management (403)
    E.m.notAllowed = true;
    await P.getByTestId('spotify-connect').click();
    await P.getByTestId('spotify-error').waitFor();
    assert(await errorCode(P) === 'not-allowed', 'account not admitted: 403 recognised');
    await shot(P, 'setup-22-not-allowed');
    await P.getByTestId('wiz-error-go').click();
    await atStep(P, 'users');
    assert(true, 'not admitted -> step 4, "Medespelers toevoegen" (User Management)');
    E.m.notAllowed = false;

    // 5. the owner of the Spotify app has no Premium
    await toConnect();
    E.m.ownerNoPremium = true;
    await P.getByTestId('spotify-connect').click();
    await P.getByTestId('spotify-error').waitFor();
    assert(await errorCode(P) === 'owner-premium' && await P.getByTestId('wiz-error-go').count() === 0, 'owner without Premium: explained, nothing to fix in the steps');
    await P.getByTestId('wiz-error-copy').click();
    await P.waitForFunction(async () => /Fout: owner-premium/.test(await navigator.clipboard.readText()));
    const details = await clip(P);
    assert(/HTTP-status: 403/.test(details) && /owner of the app/.test(details) && !details.includes(CLIENT_ID) && !/at-\d/.test(details), '"Kopieer foutdetails": status and Spotify\'s message, no token, no full Client ID');
    await shot(P, 'setup-23-owner-premium');
    E.m.ownerNoPremium = false;

    // 6. the player has no Premium: the check and the test sound say so
    E.m.product = 'free';
    E.m.premium = false;
    await P.getByTestId('spotify-connect').click();
    await P.locator('[data-testid="wiz-check-account"][data-ok="false"]').waitFor();
    assert(/Premium/.test(await P.getByTestId('wiz-no-premium').textContent()), 'no Premium: shown at the account check');
    await P.locator('[data-testid="wiz-check-device"][data-ok="true"]').waitFor();
    await P.getByTestId('spotify-test').click();
    await P.waitForFunction(() => /Premium/.test(document.querySelector('[data-testid="spotify-test-msg"]')?.textContent || ''));
    assert(await P.getByTestId('wiz-finish').count() === 0, 'no Premium: the test sound explains it, no "Klaar"');
    await shot(P, 'setup-24-no-premium');
    E.m.product = 'premium';
    E.m.premium = true;

    // 7. no playing device: the device check explains it and finds one after "Zoek opnieuw"
    E.m.devices = [];
    await toConnect();
    await P.getByTestId('spotify-connect').click();
    await P.getByTestId('device-empty').waitFor();
    assert(await P.getByTestId('wiz-check-device').getAttribute('data-ok') === 'false' && /Open de Spotify-app/.test(await P.getByTestId('device-empty').textContent()), 'no device: "Open de Spotify-app op dit toestel…"');
    await shot(P, 'setup-25-no-device');
    E.m.devices = [{ id: 'dev-speaker', name: 'Keukenspeaker', type: 'Speaker', is_active: false, is_restricted: false }];
    await P.getByTestId('spotify-devices-refresh').click();
    await P.locator('[data-testid="wiz-check-device"][data-ok="true"]').waitFor();
    assert(/Keukenspeaker/.test(await P.getByTestId('wiz-check-device').textContent()), 'device found after "Zoek opnieuw" (the only one, chosen by itself): ✓');

    // 8. session expired / withdrawn at Spotify (refresh refused)
    E.m.access = 'revoked';
    E.m.refresh = 'revoked';
    await P.getByTestId('spotify-test').click();
    await P.getByTestId('spotify-error').waitFor();
    assert(await errorCode(P) === 'session' && /opnieuw in/.test(await P.getByTestId('spotify-error').textContent()), 'session expired: "Log opnieuw in", settings kept');
    assert(await store(P, 'timetunesr.spotify.clientId.v1') === CLIENT_ID, 'the Client ID stays');
    await shot(P, 'setup-26-session');
    await P.getByTestId('spotify-connect').click();
    await P.locator('[data-testid="spotify-block"][data-connected="true"]').waitFor();
    assert(true, 'logged in again from the error');

    // 9. something unknown (Spotify's login service down): general text + copy details
    await toConnect();
    E.m.tokenStatus = 503;
    await P.getByTestId('spotify-connect').click();
    await P.getByTestId('spotify-error').waitFor();
    assert(await errorCode(P) === 'unavailable' && /Er ging iets mis bij Spotify/.test(await P.getByTestId('spotify-error').textContent()), 'unknown error: a general explanation');
    assert(await P.getByTestId('wiz-error-copy').isVisible(), 'with "Kopieer foutdetails"');
    await noSideScroll(P, 'error');
    await shot(P, 'setup-27-unknown');
    E.m.tokenStatus = null;
    assert(e.errors.length === 0, `errors: no page errors (${e.errors.join('; ')})`);
    await e.ctx.close();

    // ================= no Clipboard API to read: the paste button explains what to do =================
    const n = await phone(browser, base, mk(), { clipboard: false });
    await n.page.goto(`${base}#/instellingen`);
    await n.page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'readText', { value: () => Promise.reject(new Error('no')) }); });
    await n.page.getByTestId('wiz-have-id').click();
    await n.page.getByTestId('wiz-paste').click();
    await n.page.waitForFunction(() => /Plakken/.test(document.getElementById('toast')?.textContent || ''));
    assert(true, 'paste not allowed: "Houd het invoerveld ingedrukt en kies Plakken"');
    await n.ctx.close();
  } finally {
    await browser.close();
    server.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
