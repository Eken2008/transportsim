# Self-hosting TransportSim

TransportSim's server is small. It runs the simulation for each game in memory and streams it to players over a WebSocket. It never stores anything: games are saved only in the host player's browser (IndexedDB), and a game ends when its host leaves for longer than the grace period. So a server needs no database, no disk space for saves and no backups.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer.
- One machine, or a container, with a public port. Players connect to the same origin that serves the client.

## Build and run

```sh
bun install
bun run build                      # builds the client into apps/client/dist
PORT=8787 bun run start            # serves the client and the game WebSocket on one port
```

Open `http://<your-host>:8787`. The server serves the built client from `apps/client/dist` and accepts game connections at `/ws`. `GET /health` returns `{"ok":true,"rooms":N}` for monitoring.

To serve the client from somewhere else (a CDN, or a separate static host), set `STATIC_DIR` to an empty folder, or leave the client out of the deployment. The client then needs to reach the server's `/ws` on the same host it was loaded from.

## Settings

Every setting is an environment variable. Unset or invalid values fall back to the defaults shown.

| Variable               | Default | What it does                                                                                                                       |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `8787`  | HTTP and WebSocket port.                                                                                                           |
| `MAX_PLAYERS`          | `15`    | Most players in one game. Hosts choose up to this many slots in the lobby.                                                         |
| `MAX_MAP_SIZE`         | `2048`  | Largest map side in tiles (maps are 128 to 4096 on a side, in powers of two). Memory and CPU grow with the square of this.         |
| `MAX_ROOMS`            | `20`    | Most games running at once. New games are refused when the server is full.                                                        |
| `HOST_GRACE_SECONDS`   | `60`    | How long a game waits for its host to reconnect before it ends. Other players see a countdown.                                     |
| `AUTOSAVE_MIN_SECONDS` | `60`    | Shortest real time between autosaves sent to a host (autosaves happen every game month, and are skipped if they come sooner).    |
| `STATIC_DIR`           | client  | Folder of static files to serve. Defaults to `apps/client/dist` when it exists.                                                     |

For example, a private server for a large group on big maps:

```sh
MAX_PLAYERS=32 MAX_MAP_SIZE=4096 MAX_ROOMS=4 HOST_GRACE_SECONDS=300 bun run start
```

## Behind a reverse proxy

Put TLS in front with any proxy that passes WebSocket upgrades. With nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
    client_max_body_size 100m;
}
```

Players upload a save when they host a game from one, and a 2048² save can reach about 20 MB, so allow large WebSocket frames. The server accepts messages up to 96 MB.

With Caddy, `reverse_proxy 127.0.0.1:8787` is enough.

## Running as a service

A systemd unit:

```ini
[Unit]
Description=TransportSim
After=network.target

[Service]
WorkingDirectory=/opt/transportsim
Environment=PORT=8787 MAX_PLAYERS=15
ExecStart=/usr/local/bin/bun apps/server/src/index.ts
Restart=on-failure
User=transportsim

[Install]
WantedBy=multi-user.target
```

Restarting the server ends every running game. Hosts keep their saves, so they can host again from the lobby.

## Sizing

Each game runs at 30 ticks a second on the server's main thread, and the cargo routing (link graph) runs in a worker thread.

- **CPU:** run `bun run bench` on the server to see what a busy game costs. It reports milliseconds per tick for a map full of vehicles across every mode. A tick that averages 3 ms takes about 9% of one core. Several games share the main thread, so add up their costs.
- **Memory:** a game takes about 15 bytes per map tile plus its vehicles: about 65 MB for a 2048² map, 250 MB for 4096².
- **Bandwidth:** each player gets the map chunks they look at, plus vehicle positions for those chunks ten times a second. Players mostly look at one area, so bandwidth depends on how busy that area is, not on the size of the map. `bun run loadtest` measures it with bot players.

## Updating

Pull, `bun install`, `bun run build`, then restart. Saves carry their own version and older saves load into newer servers: missing fields get defaults.
