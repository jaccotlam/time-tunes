// App-wide configuration, filled in once by the owner of this TimeTunesr site.
//
// SPOTIFY_CLIENT_ID: the Client ID of your own app on developer.spotify.com/dashboard
// (32 characters, not secret). Leave it empty to let every player fill in a Client ID
// on the Instellingen screen. See README.md, "Spotify koppelen".
export const SPOTIFY_CLIENT_ID = '';

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
