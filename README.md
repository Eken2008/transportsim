# TransportSim

A web-based multiplayer transport tycoon game in 2.5D. It takes inspiration from OpenTTD, Simutrans and Transport Fever. Players found transport companies, build rail, road, air and sea networks, and carry passengers and goods between towns and industries. They can compete with each other or cooperate.

> Status: all milestones of the [plan](docs/PLAN.md) (M0–M8) are in.
>
> - **World:** procedural terrain with rivers running from the hills to the sea, towns, roads and houses that grow with good service; terraforming.
> - **Climates:** temperate; sub-arctic, with a low snow line, a paper and printing chain, gold mines, and towns above the snow line that only grow with food delivered; and sub-tropical, with desert and rainforest, rubber, fruit, maize, copper ore, water and diamonds, and desert towns that only grow with food and water delivered. Towns big enough take gold and diamonds at their banks. Wagons and road vehicles carry only the climate's cargo.
> - **Towns:** each town council keeps a reputation for every company. Bulldozing the town's houses and streets costs it, and busy, well-rated stations win it back. With a poor reputation the council refuses new stations, and it refuses demolition that would leave the company very poor. Councils sell advertising campaigns (higher station ratings nearby for two months), road reconstruction (six months of road works that slow everyone's buses and trucks), a company statue (reputation, and higher ratings in the town for good), funded new buildings (three months of fast growth) and exclusive transport rights (for a year, other companies' stations in the town get nothing). They can also be bribed (a game setting), at the risk of a scandal that leaves the company shunned for six months.
> - **Rail building:** OpenTTD-style track with autorail dragging, bridges (four types by era) and tunnels; standard, electrified and high-speed track with speed limits.
> - **Stations and depots:** multi-platform stations and depots.
> - **Foundations:** as in OpenTTD, track, roads, stations, depots and airports can go on gentle slopes, raised on foundations with a cliff down to the land beside them. Straight track and roads ramp over a raised corner, a corner piece of track sits on the raised half of its tile with the cliff running diagonally beside it, and stations and depots are levelled. Track and roads don't cross a cliff.
> - **Signals:** block signals, pre-signals (entry, exit, combo) and path signals with route reservation.
> - **Trains:** an 1850–2050 vehicle catalogue; physics with power, tractive effort, gradients and curve, bridge and track speed limits; pathfinding and reversing at termini.
> - **Upkeep:** reliability that decays between services, breakdowns (a game setting), automatic service trips, ageing, autorenew and replacement rules.
> - **Accidents:** with accidents on, trains only see so far ahead, so unsafe signalling crashes trains; brake failures pass red signals; on realistic, overspeed derails trains; road vehicles stuck on level crossings are hit; aircraft can crash; ships can founder. Wreckage blocks the line or the water, and a crash closes the runway, for a while.
> - **Road vehicles:** company roads, one-way roads, bus and truck stops, road depots; buses and trucks that keep left, queue and take junctions one at a time.
> - **Air:** small (from 1930) and city (from 1955) airports with runway, gates and hangar; aircraft from mail biplanes to jumbo jets that taxi, take off, hold while the runway is busy and land. Heavy jets need a city airport; with accidents on, aircraft can crash after engine failures or landing at too small an airport.
> - **Water:** navigable rivers, canals at any height, locks between levels (also on river rapids), docks on the shore, ship depots and buoys; ferries, cargo ships, tankers and hovercraft that find their way over the water grid and wait their turn at locks. With accidents on, a ship that breaks down may founder.
> - **Lines:** vehicles run on lines, which hold the stops every vehicle on them serves: stations (full load), waypoints, depot services, conditional jumps (load, age, reliability, service due) and timetables with waits, travel times, autofill and lateness.
> - **Cargo:** passengers, mail and nine freight cargoes on refittable wagons, routed by cargodist (demand to every reachable destination, transfers between trains), paid per leg by distance and journey time.
> - **Industries:** mines, forests, farms (among their fields) and oil wells feed steel mills, factories, sawmills, food plants, refineries and power stations; towns take goods and food. Served industries grow, neglected ones close, new ones open. A cargo routes window draws the production chain (which industry types feed which, and what towns take) and lists the nearest destination for every producer; industry windows list the nearest places to bring input from and send output to. Optional inflation.
> - **Companies:** players found or join companies with roles (owner, manager, operator, viewer), and invite or accept members. Each company can build a headquarters (and move it), which grows from a small office to a skyscraper as the company's value grows.
> - **Finances:** quarterly books, in total and for each transport type (rail, road, air, water, each paying for the property it uses), loans with interest, property maintenance, company value and a league table; graphs of ten years of company history and of cargo payment rates. Three quarters in the red means bankruptcy.
> - **Competition:** station ratings from service quality; stations that cover the same houses split them by rating.
> - **Cooperation:** track and station sharing agreements with a fee per train per day.
> - **Multiplayer:** live multiplayer sync, chat with a company channel, and a news feed. The host can rename the game, change slots and visibility, and remove players.
> - **Saves:** host-only saves in the browser.
> - **Getting started:** a guide that ticks off the steps to a first working railway; synthesised sound effects and ambient traffic noise, with volume control.
> - **Scale:** a 2048² map with about 5,000 vehicles runs at about half a CPU core; players get only the updates for what they can see (about 10 KB/s each in a busy game).
>
> See [docs/PLAN.md](docs/PLAN.md) for the plan, and [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) to run your own server.

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
| `bun run bench`     | Simulation benchmark on a big map full of vehicles                   |
| `bun run loadtest`  | Bot players join one game; reports tick time and bandwidth           |

## Layout

```
packages/shared   Simulation, commands, protocol and saves. Used by both server and client.
apps/server       Minimal Bun WebSocket server: lobby, rooms, tick loop, interest management
apps/client       Vite + React UI, Three.js renderer, IndexedDB save store
scripts/          Smoke test, benchmark and load test
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
| `G` `Z` `H` `J` `K`                              | Roads: build (drag; Ctrl removes), remove, bus/truck stop, road depot, one-way |
| `Y`                                              | Airport (click its north-west corner; choose small or city airport)             |
| `U` `I` `O` `M` `X`                              | Water: canal (drag over flat land), lock (on a straight slope or river rapids), dock (on the shore), ship depot, buoy |
| `V`                                              | Convert track type (drag an area); the rail tools choose standard, electrified or high-speed track |
| `8`                                              | Bulldoze an area                                             |
| Click                                            | Open a depot, hangar or ship depot, station (show its catchment) or train (rearrange vehicles in a depot) |
| `T`                                              | Vehicle list                                                 |
| `C`                                              | Company: found or join one, members, roles, invitations      |
| `F` / `L`                                        | Finances (books, loans, infrastructure) / company league     |
| `Shift`+`T` / `Shift`+`B`, 🌳 / 🏠              | Trees / houses and industries: shown, see-through or hidden |
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

See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for proxies, running as a service and sizing.
