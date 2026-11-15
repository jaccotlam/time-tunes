// App-wide configuration, filled in once by the owner of this TimeTunesr site.
//
// SPOTIFY_CLIENT_ID: deliberately EMPTY. A Spotify app in Development Mode only admits the
// (at most 5) accounts its owner added under "User Management", and its owner needs Premium.
// TimeTunesr is played by people the maker does not know, so one shared Client ID can not
// work for them. The 30-second fragments (Apple Music, no account) are the default; whoever
// wants whole songs makes an own Spotify app and fills in their own Client ID with the
// step-by-step help on the Instellingen screen (#/instellingen/spotify). In a room the
// spelleider's Client ID goes to the players automatically. Only fill this in for a private
// copy of the site whose users are all on your own User Management list.
// See README.md, "Spotify koppelen".
export const SPOTIFY_CLIENT_ID = '';

// The addresses this TimeTunesr site runs on. Spotify only lets you log in on an address that
// is registered as a Redirect URI in your Spotify app, so the setup help shows all of them
// (with a copy button) when the app runs on one of them. Per browser (tests):
// localStorage['timetunesr.spotifyAppUrls.v1'] = '["https://…/"]'.
export const SPOTIFY_APP_URLS = [
  'https://jaccotlam.github.io/time-tunes/',
  'https://time-tunes.jaccotlam.workers.dev/',
];

// "Samen spelen" (every player on their own phone): the phones find each other through a
// PeerJS signalling server (broker); after that the game data goes directly between the
// phones (WebRTC). Default: the free public PeerJS broker, without any guarantees.
// Own broker: run `npx peerjs --port 9000` (npm package "peer") behind https and fill in
// its address, e.g. { host: 'peer.example.nl', port: 443, path: '/', secure: true, key: 'peerjs' }.
// See README.md, "Samen spelen".
export const MULTI_SIGNAL = { host: '0.peerjs.com', port: 443, path: '/', secure: true, key: 'peerjs' };
// STUN/TURN servers for WebRTC, e.g. [{ urls: 'stun:stun.example.nl:3478' }]. null = PeerJS defaults.
export const MULTI_ICE_SERVERS = null;
// Prefix of the host's id on the broker (room ABCD -> timetunesr-kamer-ABCD).
export const MULTI_PEER_PREFIX = 'timetunesr-kamer-';

// "Samen spelen" via a room server (recommended): the server holds the room and every phone
// only makes an ordinary outgoing connection to it. The Cloudflare Worker "time-tunes"
// (wrangler.jsonc, server/worker.mjs) serves the app and this server at the same address.
// Another server (e.g. the Node version on Render): fill in its https address here.
// Empty = no server: the phones connect directly through PeerJS (above), which does not work
// on every network. Per browser: localStorage['timetunesr.multiServer.v1'] = '"https://…"' (or '"off"').
// See README.md, "Server voor samen spelen".
export const MULTI_SERVER_URL = 'https://time-tunes.jaccotlam.workers.dev';
