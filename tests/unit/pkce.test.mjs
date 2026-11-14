import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  randomString, base64url, codeChallenge, authorizeUrl, tokenRequestBody, refreshRequestBody,
  parseCallback, redirectUriFor, redirectProblem, loopbackVersion,
} from '../../app/js/pkce.js';

test('codeChallenge volgt het voorbeeld uit RFC 7636', async () => {
  assert.equal(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('randomString: lengte, alleen toegestane tekens, telkens anders', () => {
  const a = randomString(64);
  const b = randomString(64);
  assert.equal(a.length, 64);
  assert.match(a, /^[A-Za-z0-9\-._~]+$/);
  assert.notEqual(a, b);
  assert.equal(randomString(128).length, 128);
});

test('base64url zonder +, / of =', () => {
  assert.equal(base64url(new Uint8Array([251, 255, 191])), '-_-_');
  assert.equal(base64url(new Uint8Array([1])), 'AQ');
});

test('authorizeUrl bevat alle PKCE-parameters', () => {
  const u = new URL(authorizeUrl({ clientId: 'abc', redirectUri: 'https://x.github.io/time-tunes/', state: 'st', challenge: 'ch', scope: 'a b' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'abc');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://x.github.io/time-tunes/');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code_challenge'), 'ch');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('scope'), 'a b');
});

test('token- en refresh-body', () => {
  const t = new URLSearchParams(tokenRequestBody({ clientId: 'c', code: 'k', redirectUri: 'https://r/', verifier: 'v' }));
  assert.deepEqual(Object.fromEntries(t), { grant_type: 'authorization_code', code: 'k', redirect_uri: 'https://r/', client_id: 'c', code_verifier: 'v' });
  const r = new URLSearchParams(refreshRequestBody({ clientId: 'c', refreshToken: 'rt' }));
  assert.deepEqual(Object.fromEntries(r), { grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'c' });
});

test('parseCallback herkent de terugkeer van Spotify', () => {
  assert.deepEqual(parseCallback('?code=abc&state=xyz'), { code: 'abc', state: 'xyz', error: null });
  assert.deepEqual(parseCallback('?error=access_denied&state=xyz'), { code: null, state: 'xyz', error: 'access_denied' });
  assert.equal(parseCallback('?code=abc'), null);
  assert.equal(parseCallback('?nosw=1'), null);
  assert.equal(parseCallback(''), null);
});

test('redirect-URI en toegestane adressen', () => {
  assert.equal(redirectUriFor('https://u.github.io/time-tunes/?x=1#/instellingen'), 'https://u.github.io/time-tunes/');
  assert.equal(redirectUriFor('http://127.0.0.1:8080/index.html#/'), 'http://127.0.0.1:8080/index.html');
  assert.equal(redirectProblem('https://u.github.io/time-tunes/'), null);
  assert.equal(redirectProblem('http://127.0.0.1:8080/'), null);
  assert.equal(redirectProblem('http://[::1]:8080/'), null);
  assert.equal(redirectProblem('http://localhost:8080/'), 'localhost');
  assert.equal(redirectProblem('http://192.168.1.10:8080/'), 'insecure');
  assert.equal(loopbackVersion('http://localhost:8080/#/instellingen'), 'http://127.0.0.1:8080/#/instellingen');
});
