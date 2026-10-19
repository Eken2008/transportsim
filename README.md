# TransportSim

A web-based multiplayer transport tycoon game in 2.5D. It takes inspiration from OpenTTD, Simutrans and Transport Fever. Players found transport companies, build rail, road, air and sea networks, and carry passengers and goods between towns and industries. They can compete with each other or cooperate.

> Status: **M2 — companies and multiplayer depth** is playable.
>
> - **World:** procedural terrain with towns, roads and houses; terraforming.
> - **Rail building:** OpenTTD-style track with autorail dragging, bridges (four types by era) and tunnels; standard, electrified and high-speed track with speed limits.
> - **Stations and depots:** multi-platform stations and depots.
> - **Signals:** block signals, pre-signals (entry, exit, combo) and path signals with route reservation.
> - **Trains:** an 1850–2050 vehicle catalogue; physics with power, tractive effort, gradients and curve, bridge and track speed limits; pathfinding and reversing at termini.
> - **Upkeep:** reliability that decays between services, breakdowns (a game setting), automatic service trips, ageing, autorenew and replacement rules.
> - **Orders:** stations (full load), waypoints, depot services, conditional jumps (load, age, reliability, service due) and timetables with waits, travel times, autofill and lateness.
> - **Passengers:** destination-based passengers with payment by distance and journey time.
> - **Companies:** players found or join companies with roles (owner, manager, operator, viewer), and invite or accept members.
> - **Finances:** quarterly books, loans with interest, property maintenance, company value and a league table. Three quarters in the red means bankruptcy.
> - **Competition:** station ratings from service quality; stations that cover the same houses split them by rating.
> - **Cooperation:** track and station sharing agreements with a fee per train per day.
> - **Multiplayer:** live multiplayer sync, chat with a company channel, and a news feed. The host can rename the game, change slots and visibility, and remove players.
> - **Saves:** host-only saves in the browser.
>
> See [docs/PLAN.md](docs/PLAN.md) for the roadmap. Advanced rail (M3: path signals, track types, breakdowns, accidents) comes next.

## Quick start

You need [Bun](https://bun.sh) 1.3 or newer.

```sh
bun install
bun run dev        # server on :8787 + Vite client on :5173
```

Open http://localhost:5173. To play against yourself, open a second browser profile or a private window, then join with the game code shown in the top bar.

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `bun run dev`       | Server (watch mode) and client dev server                            |
| `bun test`          | Unit and integration tests (shared simulation + server)              |
| `bun run typecheck` | TypeScript checks for all packages                                   |
| `bun run build`     | Production build of the client into `apps/client/dist`               |
| `bun run start`     | Server only; serves `apps/client/dist` if it exists                  |
| `bun run smoke`     | Build, then run a two-player browser test (needs Node 22 and Chrome) |

## Layout

```
packages/shared   Simulation, commands, protocol and saves. Used by both server and client.
apps/server       Minimal Bun WebSocket server: lobby, rooms, tick loop, interest management
apps/client       Vite + React UI, Three.js renderer, IndexedDB save store
scripts/          Smoke test
```

All game rules live in `packages/shared`. The server runs them authoritatively, and the client runs the same code to preview build costs and errors before sending a command.

## How games are hosted

- The server is **minimal and keeps nothing on disk**. Games live in memory only.
- The player who creates a game is its **host**. If the host disconnects, the game keeps running for a grace period (60 s by default) so they can reconnect. After that it ends for everyone. If the host chooses *End game*, it ends immediately.
- Players join **without a company**. They found one, ask to join one (the owner or a manager answers), accept an invitation, or take over a company that has no members. Membership follows the player's name, which is unique within a game, so it carries over when a saved game is resumed.
- **Saves are stored only in the host's browser** (IndexedDB):
  - When a game starts, the host is asked whether to allow autosaves. Autosaves happen every in-game month, at most once a minute, and the last 3 are kept.
  - The host can also save manually, export saves as `.tsave` files, import them, and host a new game from any save.

## Controls

| Input                                            | Action               |
| ------------------------------------------------ | -------------------- |
| Right-drag                                       | Pan                  |
| Middle-drag / Alt + right-drag                   | Rotate and tilt      |
| Scroll, `+` / `-`                                | Zoom                 |
| `W` `A` `S` `D` / arrow keys                     | Move                 |
| `Q` / `E`                                        | Rotate               |
| `PgUp` / `PgDn`                                  | Tilt                 |
| `1` / `2` / `3`                                  | Raise / lower / level land (click a corner, or drag an area) |
| 🚆 menu                                          | Railway tools: track, signals, stations, depots, bridges, tunnels |
| `4` / `5`                                        | Build / remove railway (drag a route from A to B; it joins existing track; Ctrl removes) |
| `6` / `7`                                        | Station (`R` rotates) / depot                                 |
| `9`                                              | Signals: click places, turns round, removes; kinds block, entry, exit, combo (pre-signals) and path; one-way; reservation overlay |
| `B` / `N`                                        | Bridge (drag end to end) / tunnel (click a slope into a hill) |
| `P`                                              | Waypoint: click straight track (click again to remove); trains pass through without stopping |
| `V`                                              | Convert track type (drag an area); the rail tools choose standard, electrified or high-speed track |
| `8`                                              | Bulldoze an area                                             |
| Click                                            | Open a depot, station (show its catchment) or train (rearrange vehicles in a depot) |
| `T`                                              | Train list                                                   |
| `C`                                              | Company: found or join one, members, roles, invitations      |
| `F` / `L`                                        | Finances (books, loans, infrastructure) / company league     |
| `Esc`                                            | Deselect tool        |
| `Space`                                          | Pause (host only)    |
| `?`                                              | Help                 |

## Self-hosting

```sh
bun install
bun run build
MAX_PLAYERS=32 MAX_MAP_SIZE=4096 bun run start
```

| Variable               | Default           | Meaning                                                    |
| ---------------------- | ----------------- | ---------------------------------------------------------- |
| `PORT`                 | `8787`            | HTTP and WebSocket port (WebSocket path is `/ws`)          |
| `MAX_PLAYERS`          | `15`              | Maximum player slots per game                              |
| `MAX_MAP_SIZE`         | `2048`            | Largest map side in tiles (128–4096)                       |
| `MAX_ROOMS`            | `20`              | Concurrent games                                           |
| `HOST_GRACE_SECONDS`   | `60`              | How long a game waits for a disconnected host              |
| `AUTOSAVE_MIN_SECONDS` | `60`              | Minimum real time between autosaves                        |
| `STATIC_DIR`           | `apps/client/dist` | Directory of client files to serve                        |

There are two ways to point a client at a different server: `?server=host:port` in the URL, or `VITE_SERVER_URL` at build time.
