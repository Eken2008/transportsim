# TransportSim — Web-based multiplayer 2.5D transport game

## Context
The goal is a browser-based multiplayer transport tycoon game, inspired by OpenTTD, Simutrans and Transport Fever. The project folder (`D:\Home\programmering\html\transportsim`) is empty and not yet a git repo, so this is a greenfield build.

Decisions confirmed with the user:
- **Scope:** a full game, built in milestones.
- **Visuals:** 3D low-poly with a tilted, rotatable camera (Three.js), built on a **tile grid**.
- **Multiplayer:** an **authoritative TypeScript WebSocket server running on Bun**. Games are **lobby matches** (host creates, others join, save/load; no accounts). The server is **minimal and stateless across games**. It has no disk persistence, and a game is stopped when the host leaves (after a short reconnect grace period of about 60 s).
- **Saves live in the host's browser** (IndexedDB), and only after the host accepts autosaving.
- **Player cap:** a maximum of **15 players per game on our hosted server**. Self-hosters can change it (`MAX_PLAYERS` env/config).
- **Companies:** **multi-member** with roles. Companies compete, and can cooperate through track-sharing agreements.
- **Cargo:** **destination-based** (cargodist-style), with transfers.
- **Modes:** **rail first and deepest** (realistic, not overpowered), then road, then air, then water.
- **Rail depth:** train composition and physics, advanced signalling, track types and electrification, multi-tile stations, waypoints and orders.
- **Accidents and incidents in all transit modes (rail, road, air, water)**, caused by risky configurations. Severity is set per game.
- **Timeline:** era mode (vehicles unlock and age) **or** sandbox. The choice is made at game creation.
- **Scale:** maps of **1024² tiles or more**, with about 15 players by default and more when self-hosted. Chunking and interest management are needed from day one.
- **UI:** React + Vite + TypeScript, with HTML windows over the Three.js canvas.
- **Tooling:** **Bun** (1.3.4 is installed) for the package manager, workspaces, server runtime and tests.
- **Ownership:** I am fully responsible for the project. I run `git init` and commit at sensible checkpoints (at least once per milestone and after each working feature).

## Architecture

### Repo layout (Bun workspaces, TypeScript everywhere)
```
transportsim/
  package.json              # bun workspaces: packages/*, apps/*
  tsconfig.base.json
  packages/
    shared/                 # pure simulation + protocol, no DOM/Node deps
      src/world/            # Map (typed arrays), tiles, heights, chunks, terrain gen
      src/rail/             # track bits, signals, reservations, pathfinder, train physics
      src/road/  src/water/  src/air/
      src/cargo/            # cargo packets, link graph, demand/flow (cargodist)
      src/economy/          # towns, industries, chains, payments, finances, inflation
      src/company/          # companies, members, roles, permissions, sharing agreements
      src/vehicles/         # vehicle base, consists, orders, breakdowns, ageing
      src/incidents/        # collision/derailment/crossing/air/ship incident rules
      src/data/             # vehicle/industry/cargo definitions (JSON + era dates)
      src/commands/         # Command types + validate()/apply() (single source of truth)
      src/protocol/         # message schemas, binary encoding (msgpackr)
      src/sim/              # GameState, fixed-tick loop, date/calendar, settings
  apps/
    server/                 # Bun.serve WebSockets: lobby, game rooms, tick loop, interest mgmt (no disk state)
      src/config.ts         # MAX_PLAYERS (default 15), port, grace period — env-overridable
      src/workers/          # Bun Workers: link-graph solver, heavy pathfinding jobs
    client/                 # Vite + React + Three.js
      src/render/           # chunked terrain, instanced track/buildings/vehicles, LOD, picking
      src/tools/            # build tools (rail, road, station, signal, terraform, ...)
      src/ui/               # React windows: lobby, company, finances, vehicle, orders, news
      src/net/              # socket client, chunk subscriptions, interpolation
      src/saves/            # IndexedDB save store (host autosave with consent, manual save/export/import)
```

### Core principles
- **Command pattern.** The client sends a `Command` (for example `BuildTrack`, `PlaceSignal` or `StartVehicle`). The server runs the shared `validate()` and then `apply()` against the authoritative state, and broadcasts the result to interested clients. The client calls the same `validate()` so the build cursor shows red or green before sending. All game logic lives in `packages/shared`.
- **Fixed-tick simulation** on the server: 30 ticks per game second, with a game day equal to a configurable number of ticks. The host controls pause and game speed.
- **Data layout for scale.** The map is stored as struct-of-arrays in typed arrays: corner heights in a `(W+1)×(H+1)` `Uint8Array`, plus tile type, owner, track bits, road bits, signal state and so on. A 2048² map then needs about 4M tiles at a few bytes each. The map is split into **64×64-tile chunks**, each with a dirty version counter.
- **Interest management.** Each client subscribes to the chunks inside its camera frustum, plus a margin. The server sends a full chunk on subscription, then tile deltas, and vehicle states only for vehicles in subscribed chunks. Global data (companies, finances, news, cargo stats) goes to everyone.
- **Vehicle network sync.** The server sends compact binary vehicle states (id, path-segment id, offset, speed, acceleration) at about 10 Hz. The client interpolates and extrapolates along the known track geometry, so motion stays smooth without per-tick traffic.
- **Heavy jobs off the tick thread.** The cargodist link-graph solver runs in Bun Workers on a multi-day cadence, as OpenTTD does. Long pathfinding jobs can be moved there as well.
- **Minimal server.** The server holds games in memory only and keeps no files or database. Each room has a host. If the host disconnects, the room waits for a grace period (about 60 s, configurable) for the host to reconnect, then stops the game and disconnects everyone. Other players can leave and rejoin freely.
- **Save/load in the host's browser.** A save is a full snapshot of the state's typed arrays plus entity tables, encoded with msgpackr and gzipped.
  - When a game starts, the host is asked whether to allow autosaves. If they accept, the server periodically (for example every game month) streams a snapshot to the host only. The host's client stores it in **IndexedDB** with a rotating set of slots.
  - The host can also save manually, export a `.tsave` file and import one.
  - To resume, the host creates a lobby from a save in IndexedDB or an imported file, and the client uploads the snapshot to the server.

### World and rendering
- **Terrain:** OpenTTD-style slopes (each corner height differs by at most 1). Terrain is generated with simplex noise (`simplex-noise`), and includes water, rivers, trees, and placement of towns and industries.
- **Three.js renderer:** one terrain mesh per chunk, with LOD by distance. **InstancedMesh** is used for track pieces, catenary, trees, houses and vehicles. Low-poly models are generated procedurally in code at first, so no art pipeline is needed, and glTF can replace them later. The camera is tilted, can rotate freely or snap to 90°, and zooms. Picking works by raycasting against the terrain to get tile and corner coordinates. Overlays show catchment areas, signal blocks, reservations, cargo flows and ownership.
- **React UI:** draggable windows, a toolbar and a Zustand store for UI state. Simulation state lives in a `ClientWorld` class outside React, and the UI subscribes to it through small selectors.

### Rail (the main focus)
- **Track:** each tile holds 6 OpenTTD-style track bits (X, Y and 4 diagonals). Several pieces can share a tile. Rail also includes slopes, bridges (with a max speed per type), tunnels and level crossings.
- **Track types:** standard, electrified (catenary), high-speed and later maglev. Each type has its own speed limit. Curve speed limits come from the run of consecutive diagonal turns, and gradients slow trains down.
- **Signals:** block, entry, exit and combo pre-signals, path signals (PBS) and one-way path signals. Path reservation runs through junctions, and there are reservation and debug overlays.
- **Pathfinding:** A* over a track graph whose nodes are junctions, signals and stations, cached and invalidated when track changes. Signal and reservation penalties work like YAPF.
- **Consists:** built from locomotives, multiple-unit cars and wagons. Each has mass, power, tractive effort, max speed and length (in 1/16 tile). A physics step covers acceleration, braking distance, rolling and air resistance, and gradient.
- **Stations:** multi-tile, with platform count and length (and warnings when a train is longer than the platform). Rail also has waypoints, depots, sidings and yards, and catchment areas.
- **Orders:** go-to (station, waypoint or depot), full load, unload or transfer, and non-stop. Orders also cover timetables, conditional orders, servicing intervals, and autoreplace/autorenew.

### Other modes
- **Road:** road bits (4 directions) and one-way roads. Towns build their own roads. Buses and trucks follow each other and occupy intersections. Road also has bus and truck stops, depots and level crossings.
- **Air:** airports of several sizes, each with a state-machine movement graph (OpenTTD-style). Flights follow straight or great-circle-like lines, with runway occupancy and holding patterns.
- **Water:** docks, canals, locks and buoys, and ships pathfind over the water grid.

### Cargo and economy
- **Cargo packets** carry a source station, the next hop and a final destination from day one.
- **Link graph:** there is one link graph per cargo per company network. It handles demand (symmetric for passengers and mail, asymmetric for goods) and multi-commodity flow routing with transfers. The worker computes it and publishes flow tables to stations.
- **Industry chains:** coal and iron ore → steel mill → goods; wood → sawmill → goods; grain and livestock → food factory → towns; oil → refinery → goods. Industries open, close and change production.
- **Towns:** they grow based on service quality, and generate and accept passengers, mail, goods and food. Town ratings affect building permissions.
- **Money:** payment depends on cargo type, distance and transit time. Companies also have loans, quarterly finances, maintenance costs and optional inflation.

### Companies and multiplayer
- **Membership:** a company has members with roles: owner, manager (can build and spend), operator (vehicles and orders only) and viewer. Players join a company by invitation or request.
- **Competition:** station ratings decide how cargo is split between competing stations.
- **Cooperation:** track and station sharing agreements set per-train access fees, and there is an option to buy out or merge companies.
- **Lobby:** the host creates a game and other players join it.

Game creation settings:
- Map size and seed.
- **Timeline mode (era or sandbox)** and start year.
- **Accident severity (off, low or realistic)**, plus whether breakdowns are on.
- Economy difficulty.
- Player slots. The host can choose any number up to the server's `MAX_PLAYERS`, which is 15 by default and can be raised by self-hosters through an environment variable or config file.

The game also has chat, a news feed and statistics graphs.

### Accidents and incidents (all transit modes: rail, road, air, water)
- **Rail:** collisions when signalling is unsafe or missing, or when a train passes a signal at danger after a brake failure. Derailment from overspeed on curves or turnouts (realistic severity only). Collisions with road vehicles at level crossings.
- **Road:** level-crossing collisions, plus rare traffic incidents that block a tile for a while.
- **Air:** crashes from runway incursions, an aircraft too heavy for a small airport, or a breakdown at low reliability.
- **Water:** groundings and rare collisions.
- **Consequences:** the vehicle is destroyed, the tile stays blocked for a cleanup period, the company pays compensation, its reputation and station ratings drop, and the event appears in the news. Each rule lives in `shared/src/incidents/` and scales with the severity setting.

## Milestones (each one ends playable and committed)
1. **M0 Foundations.** `git init`, Bun workspaces, and tooling (TypeScript, ESLint, Prettier, `bun test`). Map typed arrays, terrain generation, chunked Three.js terrain, camera, picking and a terraform tool. Bun server lobby, rooms, host ownership and grace-period shutdown, tick loop, command pipeline and chunk subscriptions. IndexedDB save/load with an autosave consent prompt.
2. **M1 Rail core.** Track building with slopes, bridges and tunnels, plus depots and multi-tile stations. Simple consists, movement, pathfinding, block signals and orders. Towns with houses produce passengers using destination-tagged packets with simple routing. Also money, costs, and a basic company per player.
3. **M2 Companies and multiplayer depth.** Multi-member companies with roles and permissions, finances and loans, sharing agreements, station ratings, chat and news. Full lobby settings: timeline or sandbox mode and accident severity.
4. **M3 Advanced rail.** PBS, pre-signals and one-way signals, track types, electrification, curve and gradient physics, and platform length checks. Waypoints, timetables, conditional orders, breakdowns, servicing and autoreplace. **Rail accidents.**
5. **M4 Cargo and economy.** The full cargodist link graph in a worker, industries and chains, town growth, the payment model, and era vehicle data from 1850 to 2050 with ageing.
6. **M5 Road.** Roads, town road growth, buses and trucks, stops, one-way roads, traffic, and **level-crossing accidents**.
7. **M6 Air.** Airports, the aircraft state machine and **air incidents**.
8. **M7 Water.** Docks, canals, locks, buoys, ships and **ship incidents**.
9. **M8 Polish and scale.** Profiling (target: a 2048² map, 15+ players, 5k+ vehicles), LOD and instancing tuning, bandwidth tuning, statistics graphs, a tutorial and audio. Self-hosting docs covering `MAX_PLAYERS` and other config.

Implementation starts with **M0 and then M1**. Later milestones are planned in detail when they begin.

### M2 in detail
Each part ends with green tests and a commit.
1. **Companies with members and roles.** Players join a game without a company and choose one of three options: found a company, ask to join one, or spectate.
   - **Members and roles:** each member is stored by name with a role: owner, manager, operator or viewer.
   - **Permissions:** every command declares the permission it needs. Building and buying need manager or owner. Driving trains and setting orders need operator or higher. Membership and company settings need the owner.
   - **Membership commands:** found, request, invite, answer a request, set a role (handing over ownership), remove a member, leave, rename and recolour.
   - **Abandoned companies:** a company left without members can be adopted by the next player who asks to join.
   - **Names:** names are unique within a game, because membership follows the name across saves.
2. **News and chat.** A shared news feed covers companies founded and joined, a station's first train, finance warnings and agreements. The client shows a ticker and a news history window. Chat gains a company-only channel.
3. **Finances and loans.**
   - **Ledger:** a per-company ledger records income and expenses by category for each quarter and keeps a few years of history.
   - **Loans:** companies borrow and repay in steps up to a maximum loan, and the interest rate depends on difficulty.
   - **Maintenance:** track, stations and depots cost money every month.
   - **Bankruptcy:** a company with a negative balance at the end of a quarter gets warnings. After the third quarter in a row it goes bankrupt, and its vehicles and infrastructure are removed.
   - **UI:** a finances window and a company league table.
4. **Station ratings and competition.** A station's rating has these parts:
   - days since the last pickup;
   - cargo waiting;
   - the speed of the last train;
   - the age of the last vehicle;
   - a bonus for new stations.

   Houses covered by several stations send their passengers to the best-rated ones, split in proportion to rating. The station window shows how the rating is made up.
5. **Track and station sharing agreements.** One company offers another access to its track (optionally with its stations) for a fee per train per day spent on that infrastructure. The other company accepts, and either side can cancel.
   - **Linking:** track links across owners.
   - **Access checks:** pathfinding, signals and orders check access through a per-company table.
   - **Billing:** fees are counted per tick and billed daily.
   - **Cancelling:** a cancelled agreement makes trains that are still on the other company's track head home.
6. **Game settings and moderation.** A game info window shows the settings, and the host can change slots and visibility during the game and remove players. The lobby lists timeline and economy.

   Accident severity is stored now and takes effect with the M3 incident rules. Timeline mode already gates vehicle availability.

### M3 in detail
Each part ends with green tests and a commit.
1. **Signal types.**
   - **Storage:** a signal tile stores its kind in the top bits of the signals layer: block, entry, exit, combo or path. Each kind can also be one-way.
   - **Pre-signals:** an entry or combo signal is green only if its block is free and at least one exit or combo signal out of that block is green, or if the block has no exit signals.
   - **Path signals:** a train reserves the pieces of its route up to the next signal or the end of its route. Pieces cross-check for conflicts on the same tile.
   - **Mixed areas:** a train past a path signal may only enter pieces reserved for it. Block signals treat reserved pieces as occupied. Pathfinding avoids pieces other trains have reserved.
   - **UI:** signal tool options for each kind, distinct signal heads, and a reservation overlay.
2. **Track types and electrification.**
   - **Storage:** a `railType` layer holds standard, electrified or high-speed track, with a speed limit per type.
   - **Electric traction:** electric engines need electrified track along their whole path.
   - **Building and conversion:** the build tool picks a type, a convert tool upgrades track for the difference in cost, and the client draws catenary masts and wires.
3. **Curve and gradient physics, and platform length.**
   - **Curve limits:** from the run of 45° turns ahead (tight, medium or gentle) and from switches.
   - **Gradients:** carry the train's mass along its length.
   - **Bridges and track types:** cap speed.
   - **Platform length:** trains stop with the whole train on the platform where it fits. A train longer than the platform loads more slowly, and its window warns about it.
4. **Orders.** Waypoints (buildable single tiles that orders can name, passed without stopping), non-stop orders, timetables (wait times, and lateness shown in the train window), and conditional orders that jump on load, age, reliability or a needed service.
5. **Breakdowns, servicing and ageing.**
   - **Reliability:** each engine's reliability decays between services. A breakdown stops a train for a while, and its odds follow reliability and the breakdown setting.
   - **Servicing:** trains visit a depot for service at an interval.
   - **Ageing:** vehicles age past their lifespan and lose reliability.
   - **Renewal:** autorenew replaces old vehicles in a depot, and autoreplace swaps one vehicle type for another.
6. **Rail accidents.** With accidents on:
   - two trains meeting on the same piece collide;
   - a broken-down train's brakes may fail, so it passes a red signal;
   - with realistic severity, overspeed on tight curves derails a train.

   An accident destroys the trains involved and blocks the tiles for cleanup. The company pays compensation, its station ratings drop, and the news reports it. Level-crossing collisions wait for road vehicles (M5).

## Key dependencies
`three`, `react`, `react-dom`, `zustand`, `vite`, `@vitejs/plugin-react`, `msgpackr`, `simplex-noise`, `idb` (a small IndexedDB wrapper) and `concurrently` (to run client and server together in dev). The server uses Bun's built-in `Bun.serve` WebSockets, so it needs no `ws` package, and tests use `bun test`.

## Commits
I commit at sensible checkpoints: once the scaffold works, after each feature works (with tests green), and at the end of each milestone. Commit messages are clear and end with the required Co-Authored-By line.

## Verification
- **Unit tests (`bun test`, `packages/shared`):** track placement and slope rules, signal and reservation logic, pathfinder results, train physics (braking distance, climbing a gradient), cargo routing, command validation, and save/load round-trips.
- **Server tests:** a host disconnect stops the room after the grace period, `MAX_PLAYERS` is enforced, and an uploaded save resumes correctly.
- **Headless scenario tests:** scripted maps run for N ticks, for example: "two trains, single track, no signals → collision incident when severity is on", "PBS junction → no deadlock", "passengers reach their destination through a transfer".
- **Run it:** `bun run dev` starts the server and Vite. Open two browser tabs, create and join a lobby, build track, a station and a train, and confirm both tabs see the same state and the train moves smoothly.
  - Accept autosave, then confirm a save appears in IndexedDB (DevTools → Application).
  - Close the host tab, and confirm the other tab is told the game ended after the grace period.
  - Reload from the save.
- **Load test:** a bot-client script that connects 15+ simulated players issuing commands on a large map, and measures tick time and bytes per client per second.
- **Client smoke test:** Playwright opens the client, creates a lobby and takes a screenshot of the rendered terrain.
