import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { loadConfig } from './config.ts';
import { Lobby } from './lobby.ts';
import type { Connection } from './room.ts';

const config = loadConfig();
const lobby = new Lobby(config);

const defaultStatic = resolve(import.meta.dir, '../../client/dist');
const staticDir = config.staticDir ?? (existsSync(defaultStatic) ? defaultStatic : null);

interface SocketData {
  conn: Connection;
}

const server = Bun.serve<SocketData, never>({
  port: config.port,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const data = { conn: null as unknown as Connection };
      if (srv.upgrade(req, { data })) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    if (url.pathname === '/health') {
      return Response.json({ ok: true, rooms: lobby.rooms.size });
    }
    return serveStatic(url.pathname);
  },
  websocket: {
    // Saves can be large (a 2048² map is ~20 MB uncompressed).
    maxPayloadLength: 96 * 1024 * 1024,
    // Compression is done per frame in the codec (Bun's permessage-deflate drops large inbound messages).
    perMessageDeflate: false,
    idleTimeout: 120,
    open(ws: ServerWebSocket<SocketData>) {
      ws.data.conn = {
        send: (bytes) => {
          ws.send(bytes);
        },
        close: () => ws.close(),
      };
    },
    message(ws, message) {
      if (typeof message === 'string') return;
      lobby.onMessage(ws.data.conn, message);
    },
    close(ws) {
      lobby.onClose(ws.data.conn);
    },
  },
});

function serveStatic(pathname: string): Response {
  if (!staticDir) return new Response('TransportSim server. Run the client with `bun run dev`.', { status: 200 });
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(staticDir, rel);
  if (!file.startsWith(staticDir)) return new Response('Forbidden', { status: 403 });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticDir, 'index.html'); // SPA fallback
  return new Response(Bun.file(file));
}

const shutdown = () => {
  lobby.shutdown();
  server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(
  `TransportSim server on :${server.port} (max ${config.maxPlayers} players/game, map ≤ ${config.maxMapSize}², ${config.maxRooms} games)` +
    (staticDir ? `, serving ${staticDir}` : ''),
);
