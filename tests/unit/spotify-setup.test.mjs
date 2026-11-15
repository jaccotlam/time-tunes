// Spotify with an own Client ID: the pure parts of the setup help (app/js/spotify-setup.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEPS, stepNumber, nextStep, prevStep, cleanClientId, clientIdMessage, looksLikeClientId, redirectList,
  shareLink, parseShareHash, codeForCallback, codeForToken, codeForApi, explain, EXPLAIN, errorDetails,
} from '../../app/js/spotify-setup.js';

const ID = '0123456789abcdef0123456789abcdef';

test('vijf genummerde stappen, met intro ervoor en klaar erna', () => {
  assert.deepEqual(STEPS.map((s) => s.key), ['dashboard', 'app', 'clientid', 'users', 'connect']);
  assert.equal(stepNumber('app'), 2);
  assert.equal(nextStep('users'), 'connect');
  assert.equal(nextStep('connect'), 'done');
  assert.equal(prevStep('dashboard'), 'intro');
  assert.equal(prevStep('clientid'), 'app');
  assert.ok(STEPS.find((s) => s.key === 'users').optional, 'medespelers toevoegen is over te slaan');
});

test('Client ID: spaties, regeleinden, onzichtbare tekens en aanhalingstekens weg', () => {
  for (const raw of [ID, `  ${ID}  `, `0123 4567 89ab cdef\n0123 4567 89ab cdef`, `​${ID}﻿`, `"${ID}"`, `“${ID}”`, ID.toUpperCase(), `\t${ID}\r\n`]) {
    const c = cleanClientId(raw);
    assert.equal(c.ok, true, JSON.stringify(raw));
    assert.equal(c.value, ID);
  }
  assert.equal(cleanClientId(`Client ID ${ID}`).value, ID, 'een meegekopieerd label');
  assert.equal(cleanClientId(`Client ID\n${ID}\nView client secret`).ok, true);
});

test('Client ID: begrijpelijke melding bij te kort, te lang, verkeerde tekens of leeg', () => {
  const short = cleanClientId('abc123');
  assert.equal(short.ok, false);
  assert.equal(short.problem, 'short');
  assert.match(clientIdMessage(short), /6 tekens.*precies 32/);
  const long = cleanClientId(`${ID}ab`);
  assert.equal(long.problem, 'long');
  assert.match(clientIdMessage(long), /34 tekens/);
  const chars = cleanClientId('0123456789abcdef0123456789abcdeg');
  assert.equal(chars.problem, 'chars');
  assert.match(clientIdMessage(chars), /0-9 en de letters a-f/);
  assert.equal(cleanClientId('   ').problem, 'empty');
  assert.equal(clientIdMessage(cleanClientId(ID)), null);
  assert.equal(cleanClientId(`${ID} ${ID.replace(/0/g, '1')}`).ok, false, 'twee ID\'s: niet raden');
  assert.equal(looksLikeClientId(ID), true);
  assert.equal(looksLikeClientId(`${ID} `), false);
  assert.equal(looksLikeClientId(null), false);
});

test('Redirect URIs: het huidige adres eerst, de andere adressen van de site erbij', () => {
  const urls = ['https://jaccotlam.github.io/time-tunes/', 'https://time-tunes.jaccotlam.workers.dev/'];
  assert.deepEqual(redirectList('https://time-tunes.jaccotlam.workers.dev/#/instellingen?x=1', urls), [
    { uri: 'https://time-tunes.jaccotlam.workers.dev/', current: true },
    { uri: 'https://jaccotlam.github.io/time-tunes/', current: false },
  ]);
  assert.deepEqual(redirectList('https://jaccotlam.github.io/time-tunes/index.html#/', urls), [{ uri: 'https://jaccotlam.github.io/time-tunes/index.html', current: true }], 'een ander pad: alleen dat adres');
  assert.deepEqual(redirectList('http://127.0.0.1:8080/#/instellingen', urls), [{ uri: 'http://127.0.0.1:8080/', current: true }], 'een eigen kopie (lokaal): alleen het eigen adres');
  assert.deepEqual(redirectList('nonsense', urls), []);
});

test('deel-link: maken en lezen, met naam; ongeldige links geweigerd', () => {
  const link = shareLink('https://jaccotlam.github.io/time-tunes/', ID.toUpperCase(), '  Anna <b>de Vries</b> ');
  assert.equal(link, `https://jaccotlam.github.io/time-tunes/#/spotify-delen/${ID}?van=Anna%20bde%20Vries%2Fb`);
  const hash = link.slice(link.indexOf('#'));
  assert.deepEqual(parseShareHash(hash), { clientId: ID, from: 'Anna bde Vries/b' });
  assert.deepEqual(parseShareHash(`#/spotify-delen/${ID}`), { clientId: ID, from: '' });
  assert.equal(shareLink('https://x.nl/#/oud', ID), `https://x.nl/#/spotify-delen/${ID}`, 'geen oude hash in de link');
  assert.equal(shareLink('https://x.nl/', 'kort'), null);
  assert.equal(parseShareHash('#/spotify-delen/123'), null);
  assert.equal(parseShareHash(`#/spotify-delen/${ID}x`), null);
  assert.equal(parseShareHash(`#/pl/${ID}`), null);
  assert.equal(parseShareHash(`#/spotify-delen/${ID}?van=${'x'.repeat(200)}`).from.length, 40, 'naam ingekort');
});

test('foutherkenning: terugkeer van Spotify', () => {
  assert.equal(codeForCallback('access_denied'), 'denied');
  assert.equal(codeForCallback('invalid_client'), 'client');
  assert.equal(codeForCallback('invalid_request', 'Invalid redirect URI'), 'redirect');
  assert.equal(codeForCallback('iets_nieuws'), 'client');
});

test('foutherkenning: token-endpoint', () => {
  assert.equal(codeForToken(400, { error: 'invalid_client', error_description: 'Invalid client' }), 'client');
  assert.equal(codeForToken(400, { error: 'invalid_grant', error_description: 'Invalid redirect URI' }), 'redirect');
  assert.equal(codeForToken(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' }), 'session');
  assert.equal(codeForToken(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' }, 'refresh'), 'session');
  assert.equal(codeForToken(400, { error: 'invalid_client' }, 'refresh'), 'session');
  assert.equal(codeForToken(403, {}), 'not-allowed');
  assert.equal(codeForToken(403, { error_description: 'Active premium subscription required for the owner of the app.' }), 'owner-premium');
  assert.equal(codeForToken(429, {}), 'rate');
  assert.equal(codeForToken(503, {}), 'unavailable');
  assert.equal(codeForToken(400, null), 'client', 'geen JSON');
});

test('foutherkenning: Web API (tolerant voor de echte teksten)', () => {
  const e = (status, message, reason) => ({ error: { status, message, ...(reason ? { reason } : {}) } });
  assert.equal(codeForApi(401, e(401, 'The access token expired')), 'session');
  assert.equal(codeForApi(403, e(403, 'Check settings on developer.spotify.com/dashboard, the user may not be registered.'), '', '/me'), 'not-allowed');
  assert.equal(codeForApi(403, e(403, 'User not registered in the Developer Dashboard')), 'not-allowed');
  assert.equal(codeForApi(403, e(403, 'Forbidden'), '', '/me'), 'not-allowed', '/me weigert alleen bij een niet-toegelaten account');
  assert.equal(codeForApi(403, e(403, 'Insufficient client scope'), '', '/me/top/tracks'), 'forbidden');
  assert.equal(codeForApi(403, e(403, 'Player command failed: Premium required', 'PREMIUM_REQUIRED')), 'premium');
  assert.equal(codeForApi(403, e(403, 'Active premium subscription required for the owner of the app.'), '', '/me'), 'owner-premium');
  assert.equal(codeForApi(404, e(404, 'Player command failed: No active device found', 'NO_ACTIVE_DEVICE')), 'no-device');
  assert.equal(codeForApi(404, e(404, 'Device not found')), 'no-device');
  assert.equal(codeForApi(404, e(404, 'Service not found')), 'unavailable');
  assert.equal(codeForApi(429, null), 'rate');
  assert.equal(codeForApi(500, null, '<html>'), 'unavailable');
});

test('elke fout heeft een titel, één handeling en de juiste stap; onbekend = algemene uitleg', () => {
  assert.equal(explain('redirect').step, 'app');
  assert.equal(explain('client').step, 'clientid');
  assert.equal(explain('not-allowed').step, 'users');
  assert.equal(explain('premium').step, null);
  assert.equal(explain('denied').step, 'connect');
  assert.equal(explain('session').step, 'connect');
  assert.equal(explain('no-device').step, 'connect');
  assert.equal(explain('iets-raars'), EXPLAIN.unknown);
  for (const [k, x] of Object.entries(EXPLAIN)) {
    assert.ok(x.title && x.text, k);
    if (x.step) assert.ok(x.button, `${k}: knop`);
  }
  assert.match(explain('client').text, /Client secret/);
  assert.match(explain('redirect').text, /Redirect URIs/);
  assert.match(explain('not-allowed').text, /User Management/);
});

test('foutdetails: bruikbaar, zonder tokens en zonder de hele Client ID', () => {
  const t = errorDetails({ code: 'unknown', detail: { where: 'GET /me', status: 500, message: 'boom' }, redirectUri: 'https://x.nl/', clientId: ID, appVersion: '3', userAgent: 'UA', at: 0 });
  assert.match(t, /Fout: unknown/);
  assert.match(t, /HTTP-status: 500/);
  assert.match(t, /Melding van Spotify: boom/);
  assert.match(t, /Redirect URI: https:\/\/x\.nl\//);
  assert.ok(!t.includes(ID), 'Client ID ingekort');
  assert.match(errorDetails({}), /Client ID: \(geen\)/);
});
