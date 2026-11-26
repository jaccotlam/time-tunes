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
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createRoomServer } from './core.mjs';
import { LIMITS, DEFAULT_ORIGINS } from './policy.mjs';
import { MAX_CLIENT_MESSAGE } from '../app/js/multi/server-protocol.js';

export function startNodeServer({
  port = Number(process.env.PORT) || 8787, host = process.env.HOST || '0.0.0.0', origins = process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS, quiet = false,
  accountsFile = process.env.ACCOUNTS_FILE || '', iterations, now,
} = {}) {
  const log = quiet ? () => {} : (...a) => console.log(new Date().toISOString(), ...a);
  const core = createRoomServer({ origins, log, accountsFile, ...(iterations ? { iterations } : {}), ...(now ? { now } : {}) });
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.maxBody) { res.writeHead(413).end(); req.destroy(); return; }
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

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE, perMessageDeflate: false });
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
