// The own playlist both multi-*-playlist suites put on the spelleider's phone (6 known iTunes tracks).
export const TRACKS = [
  [6800311742, 'Dancing Queen', 'ABBA', 1976], [1440763833, 'Gold Digger', 'Kanye West', 2005],
  [1308586364, 'Back for Good', 'Take That', 1995], [1322068804, 'Mambo No. 5 (A Little Bit Of...)', 'Lou Bega', 1999],
  [268284600, '...Baby One More Time', 'Britney Spears', 1998], [1440741632, 'In the Summertime', 'Mungo Jerry', 1970],
].map(([itunesId, title, artist, year], i) => ({ n: i + 1, itunesId, title, artist, year }));
