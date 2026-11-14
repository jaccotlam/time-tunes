import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle, normalizeArtist, splitArtists, titleScore, artistScore, scoreTrack,
  bestMatch, rankTracks, searchQueries, isSpotifyId,
} from '../../app/js/spotify-match.js';

// Track objects shaped like GET /v1/search?type=track results (Development Mode: no popularity).
let n = 0;
const tr = (name, artists, album = name, ms = 200000) => {
  n++;
  const id = `id${String(n).padStart(20, '0')}`;
  return { id, uri: `spotify:track:${id}`, name, duration_ms: ms, artists: artists.map((a) => ({ name: a })), album: { name: album } };
};

test('normalizeTitle negeert accenten, haakjes, feat. en remaster-achtervoegsels', () => {
  assert.equal(normalizeTitle('Dancing Queen - Remastered 2001'), 'dancing queen');
  assert.equal(normalizeTitle('Aserejé (Spanglish Version)'), 'asereje');
  assert.equal(normalizeTitle('Gold Digger (feat. Jamie Foxx)'), 'gold digger');
  assert.equal(normalizeTitle('One Kiss [with Dua Lipa]'), 'one kiss');
  assert.equal(normalizeTitle("Don't You (Forget About Me)"), 'dont you');
  assert.equal(normalizeTitle('Mambo No. 5 (A Little Bit Of...)'), 'mambo no 5');
  assert.equal(normalizeTitle('(I Can’t Get No) Satisfaction - Mono Version'), 'satisfaction');
  assert.equal(normalizeArtist('The Rolling Stones'), 'rolling stones');
  assert.equal(normalizeArtist('Beyoncé'), 'beyonce');
  assert.deepEqual(splitArtists('Calvin Harris & Dua Lipa'), ['calvin harris', 'dua lipa']);
  assert.deepEqual(splitArtists('Kanye West feat. Jamie Foxx'), ['kanye west', 'jamie foxx']);
});

test('titel- en artiestscores', () => {
  assert.equal(titleScore('Wake Me Up Before You Go-Go', 'Wake Me Up Before You Go Go'), 1);
  assert.equal(titleScore('The Ketchup Song (Aserejé)', 'Aserejé (The Ketchup Song)'), 1);
  assert.ok(titleScore('Dancing Queen', 'Waterloo') < 0.5);
  assert.equal(artistScore('Simon & Garfunkel', [{ name: 'Simon & Garfunkel' }]), 1);
  assert.equal(artistScore('Calvin Harris & Dua Lipa', [{ name: 'Calvin Harris' }, { name: 'Dua Lipa' }]), 1);
  assert.ok(artistScore('Calvin Harris & Dua Lipa', [{ name: 'Calvin Harris' }]) >= 0.8);
  assert.equal(artistScore('Las Ketchup', [{ name: 'Las Ketchup' }]), 1);
  assert.equal(artistScore('Beyoncé', [{ name: 'Beyonce' }]), 1);
  assert.ok(artistScore('ABBA', [{ name: 'The Hit Crew' }]) < 0.3);
});

test('remaster telt als het origineel; bij gelijke score wint de eerste van Spotify', () => {
  const card = { title: 'Dancing Queen', artist: 'ABBA' };
  const items = [
    tr('Dancing Queen', ['ABBA'], 'Arrival'),
    tr('Dancing Queen - Remastered 2001', ['ABBA'], 'Gold'),
  ];
  const m = bestMatch(card, items);
  assert.equal(m.id, items[0].id);
  assert.equal(m.uri, items[0].uri);
  assert.equal(m.sure, true);
  // reversed order: the remaster now comes first and wins the tie
  assert.equal(bestMatch(card, [items[1], items[0]]).id, items[1].id);
});

test('live, karaoke en covers worden vermeden', () => {
  const card = { title: 'Bohemian Rhapsody', artist: 'Queen' };
  const live = tr('Bohemian Rhapsody - Live Aid', ['Queen'], 'Live Aid');
  const karaoke = tr('Bohemian Rhapsody (Karaoke Version)', ['Queen'], 'Karaoke Hits');
  const cover = tr('Bohemian Rhapsody', ['The Hit Crew'], 'Tribute to Queen');
  const style = tr('Bohemian Rhapsody (In the Style of Queen)', ['Ameritz Karaoke'], 'Karaoke');
  const studio = tr('Bohemian Rhapsody - Remastered 2011', ['Queen'], 'A Night At The Opera');
  const m = bestMatch(card, [live, karaoke, cover, style, studio]);
  assert.equal(m.id, studio.id);
  const ranked = rankTracks(card, [live, karaoke, cover, style, studio]);
  assert.equal(ranked[0].track.id, studio.id);
  assert.ok(scoreTrack(card, live).flags.includes('live'));
  assert.ok(scoreTrack(card, karaoke).flags.includes('karaoke'));
  // only versions we do not want: no reliable match
  assert.equal(bestMatch(card, [karaoke, cover, style]), null);
});

test('een titel met "Live" erin mag gewoon live heten', () => {
  const card = { title: 'Live and Let Die', artist: 'Paul McCartney & Wings' };
  const t = tr('Live And Let Die - 2018 Remaster', ['Wings'], 'Wings Greatest');
  const t2 = tr('Live and Let Die', ['Paul McCartney', 'Wings']);
  assert.equal(bestMatch(card, [t2, t]).id, t2.id);
  assert.ok(bestMatch(card, [t]), 'remaster by "Wings" alone is still accepted');
  const remixCard = { title: 'Lady (Hear Me Tonight) [Remix]', artist: 'Modjo' };
  assert.equal(scoreTrack(remixCard, tr('Lady (Hear Me Tonight) - Remix', ['Modjo'])).penalty, 0);
});

test('feat. en accenten', () => {
  const card = { title: 'Gold Digger', artist: 'Kanye West' };
  const t = tr('Gold Digger', ['Kanye West', 'Jamie Foxx'], 'Late Registration');
  assert.equal(bestMatch(card, [t]).id, t.id);
  const card2 = { title: 'The Ketchup Song (Aserejé)', artist: 'Las Ketchup' };
  const spanglish = tr('Aserejé - Spanglish Version', ['Las Ketchup']);
  const orig = tr('Aserejé (The Ketchup Song)', ['Las Ketchup']);
  assert.equal(bestMatch(card2, [orig, spanglish]).id, orig.id);
  const card3 = { title: 'Crazy in Love', artist: 'Beyoncé feat. JAY-Z' };
  const t3 = tr('Crazy In Love (feat. Jay-Z)', ['Beyoncé', 'JAY-Z']);
  assert.equal(bestMatch(card3, [t3]).id, t3.id);
});

test('verkeerde artiest of verkeerd nummer: geen match', () => {
  const card = { title: 'Back for Good', artist: 'Take That' };
  assert.equal(bestMatch(card, [tr('Back for Good', ['Boyzone'])]), null);
  assert.equal(bestMatch(card, [tr('Pray', ['Take That'])]), null);
  assert.equal(bestMatch(card, []), null);
  assert.equal(bestMatch(card, null), null);
  // tracks that cannot play in this market are skipped
  const blocked = { ...tr('Back for Good', ['Take That']), is_playable: false };
  assert.equal(bestMatch(card, [blocked]), null);
});

test('zoekopdrachten: eerst met velden, dan los', () => {
  const [strict, loose] = searchQueries({ title: 'Mambo No. 5 (A Little Bit Of...)', artist: 'Lou Bega' });
  assert.equal(strict, 'track:"Mambo No. 5" artist:"Lou Bega"');
  assert.equal(loose, 'Mambo No. 5 A Little Bit Of... Lou Bega');
  assert.equal(searchQueries({ title: 'One Kiss', artist: 'Calvin Harris & Dua Lipa' })[0], 'track:"One Kiss" artist:"Calvin Harris"');
  assert.equal(searchQueries({ title: 'Say "Hi"', artist: 'X' })[0], 'track:"Say Hi" artist:"X"');
  assert.equal(isSpotifyId('4uLU6hMCjMI75M1A2tKUQC'), true);
  assert.equal(isSpotifyId('spotify:track:4uLU6hMCjMI75M1A2tKUQC'), false);
});
