// Node adapter of the room server: `node server/node.mjs` (listens on $PORT, default 8787).
// Runs on any Node host (Render, Fly, a VPS ...). Rooms live in memory: a restart empties the
// server, after which the spelleider's phone puts its room back (backup, see room.mjs).
//
// Environment:
//   PORT             port to listen on (default 8787)
//   HOST             interface (default 0.0.0.0)
//   ALLOWED_ORIGINS  comma-separated origins that may connect, e.g.
//                    "https://jaccotlam.github.io,http://localhost:*" (default: see policy.mjs)
//   ACCOUNTS_FILE    JSON file that keeps the accounts and their prepared rooms across a restart
//                    (written atomically; holds password hashes: keep it private). Empty (default):
//                    accounts and prepared rooms live in memory only and a restart loses them.
//   TRUST_PROXY      how many proxies YOU control sit in front of this server (default 0). The
//                    per-IP limits (rooms, sockets, sign-ups, failed logins) count per client
//                    address: with 0 that is the socket's own address and X-Forwarded-For is
//                    ignored (any client can write that header). With N > 0 it is the N-th
//                    address from the right in X-Forwarded-For: the one the outermost trusted
//                    proxy appended (proxies append; everything left of that is the client's
//                    own, unverified text). Render: 1 (render.yaml), its proxy appends the address
//                    that connected to it.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createRoomServer } from './core.mjs';
import { LIMITS, DEFAULT_ORIGINS, corsHeaders, originAllowed, parseOrigins } from './policy.mjs';
import { accountBodyMax } from './account-http.mjs';
import { MAX_CLIENT_MESSAGE } from '../app/js/multi/server-protocol.js';

/** The client address for the per-IP limits (see TRUST_PROXY above). */
export function clientAddress({ forwardedFor = '', remote = '', trustProxy = 0 }) {
  const hops = Math.max(0, Math.min(10, Math.floor(Number(trustProxy) || 0)));
  if (hops > 0) {
    const list = String(forwardedFor || '').split(',').map((x) => x.trim()).filter(Boolean);
    // fewer entries than trusted proxies: the header did not pass all of them; take the first one there is
    if (list.length) return list[Math.max(0, list.length - hops)];
  }
  return remote || '?';
}

export function startNodeServer({
  port = Number(process.env.PORT) || 8787, host = process.env.HOST || '0.0.0.0', origins = process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS, quiet = false,
  accountsFile = process.env.ACCOUNTS_FILE || '', iterations, now, trustProxy = process.env.TRUST_PROXY || 0, limits,
} = {}) {
  const log = quiet ? () => {} : (...a) => console.log(new Date().toISOString(), ...a);
  const core = createRoomServer({ origins, log, accountsFile, ...(iterations ? { iterations } : {}), ...(now ? { now } : {}), ...(limits ? { limits } : {}) });
  const allowed = parseOrigins(origins);
  const clientIp = (req) => clientAddress({ forwardedFor: req.headers['x-forwarded-for'], remote: req.socket.remoteAddress, trustProxy });

  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    // an account route has a much smaller limit (a login body is tiny): refused before reading it
    const max = accountBodyMax(req.method, new URL(req.url, 'http://x').pathname) ?? LIMITS.maxBody;
    const tooBig = () => {
      const origin = req.headers.origin || '';
      res.writeHead(413, { ...(originAllowed(origin, allowed) ? corsHeaders(origin) : {}), 'content-type': 'application/json; charset=utf-8', connection: 'close' });
      res.end(JSON.stringify({ code: 'size', error: 'size', message: 'Dit verzoek is te groot.' }));
      res.on('finish', () => req.destroy());
    };
    if (Number(req.headers['content-length']) > max) { tooBig(); return; }
    req.on('data', (c) => {
      if (res.writableEnded) return;
      size += c.length;
      if (size > max) { tooBig(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const url = new URL(req.url, 'http://x');
      const send = (out) => {
        res.writeHead(out.status, out.headers);
        res.end(out.body == null || req.method === 'HEAD' ? undefined : JSON.stringify(out.body));
      };
      const out = core.http({ method: req.method, path: url.pathname, origin: req.headers.origin || '', ip: clientIp(req), auth: req.headers.authorization || '', body: Buffer.concat(chunks).toString('utf8') });
      // an /account route answers later (password hashing); the room routes at once
      if (typeof out?.then === 'function') out.then(send, () => { if (!res.headersSent) res.writeHead(500).end(); });
      else send(out);
    });
  });

  // a little room above the largest valid message: the room answers a too big deck with a
  // clear error instead of `ws` closing the connection (above this `ws` still closes it)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * MAX_CLIENT_MESSAGE, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const check = core.upgrade({ path: url.pathname, origin: req.headers.origin || '', ip: clientIp(req) });
    if (!check.ok) {
      socket.write(`HTTP/1.1 ${check.status} ${check.reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = check.attach({
        send: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); },
        close: (code, reason) => { try { ws.close(code, reason); } catch { ws.terminate(); } },
      });
      ws.on('message', (data, isBinary) => { if (!isBinary) conn.message(data.toString('utf8')); });
      ws.on('close', () => conn.closed());
      ws.on('error', () => { try { ws.terminate(); } catch { /* ignore */ } });
    });
  });

  const timer = setInterval(() => core.sweep(), 5000);
  timer.unref?.();

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      log(`TimeTunesr kamerserver luistert op poort ${actual}`);
      resolve({
        port: actual,
        core,
        close: () => new Promise((r) => {
          clearInterval(timer);
          core.flush();
          for (const ws of wss.clients) ws.terminate();
          server.close(() => r());
          setTimeout(r, 500);
        }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // the last net: one room's bug must not end the game in every other room on this server
  process.on('uncaughtException', (e) => console.error('uncaught:', e?.stack || e));
  process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.stack || e));
  const s = await startNodeServer();
  const stop = () => { s.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
