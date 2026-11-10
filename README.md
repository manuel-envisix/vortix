# Vortix · Agent Command Center

A cinematic AI fleet frontend with the Synvix monitoring backend. The original layout and optimized renderer are retained. Demo mode remains entirely simulated; live mode uses authenticated provider/reporting events. Read [backend setup](docs/backend.md) and the [integration research matrix](docs/integration-matrix.md) before configuring credentials.

## Run

```sh
npm install
npm run dev
```

Open the local URL printed by Vite (normally http://127.0.0.1:5173). Use `npm run build` for a production bundle in `dist/`, and `npm test` for the simulation consistency suite.

## Explore

- Explore the Galaxy constellation with 20 simulated agents. Fleet sizing remains supported by the data model; there is no amount picker.
- Click an agent node, role symbol, explorer entry, or activity event to inspect and focus it.
- Use **Work / Collaboration / Delivery** to inspect simulated output, related agents, pull requests, and pipeline stages.
- Filter by project, search, activity, or status. `/` opens agent search; `Escape` closes overlays and exits presentation.
- Drag to orbit; scroll to zoom. The focus icon resets the camera. Presentation hides secondary panels and rotates the camera; manual navigation stops rotation.
- Open settings to disable ambient effects. Pause, reset, and playback speed remain in the bottom bar.
- GPU node rings show working (blue), waiting (amber), and complete (mint). Small PR indicators show draft/open/merged; CI indicators show running/passed. Select a node for full text; accessible explorer buttons expose the same state.

## Structure

`src/simulation.ts` owns the typed data model, seeded simulation, bounded event history, and derived delivery artifacts. The `AgentDataSource` interface is the replacement point for a future real data source. `src/World.tsx` owns the Galaxy layout and camera navigation. `src/App.tsx` owns HUD state and inspection. `src/style.css` contains the Envisix-inspired design tokens and responsive overlays.

The simulation is deterministic per tick. Fleet sizes are clamped to 1–100. Each agent has a stable identity, task lifecycle, and optional parent in the same project. PR state and pipeline stages derive from the selected task's progress. Reset reproduces the same starting snapshot. Display filters do not remove agents from the simulation.

## Verification

- TypeScript and production bundling passed during implementation.
- The simulation suite covers: 400 simulation ticks at each of 1, 5, 20, 60, and 100 agents, plus deterministic replay/reset. Checks cover progress bounds, unique IDs, valid parents/events, bounded history, and consistent PR/CI completion.
- Browser verification now works in the in-app browser. The production preview was checked at 1101×831: overview samples showed about 30–31 rendered fps at the intentional 30 Hz background target, 14 draw calls, zero per-agent HTML markers, and no WebGL errors. GPU picking, search, inspector selection, and PR/CI delivery inspection were exercised. This is a short sample on this machine, not a sustained benchmark or a guarantee at other resolutions.
- Instanced fleet geometry and energy particles, capped pixel ratio, bounded event history, and optional ambient effects constrain rendering work. Reduced-motion preferences disable continuous animation and automatic camera movement. A readable fleet fallback is provided for unavailable 3D.

Fonts use Google Fonts when reachable, with local system fallbacks. No external data integration is used.

## Performance implementation

Agent icons, status rings, and PR/CI symbols are one instanced GPU draw call using a shared glyph atlas. Only the selected agent has an HTML label; the accessible explorer remains available for every agent. Orbit rings use instancing, and all network connections share one line-segment geometry. In the overview this reduced measured draw calls from 41 to 14 compared with the earlier revision.

The canvas renders on demand with a 30 Hz background animation budget; camera interactions may request additional frames. Hidden/off-screen tabs suspend the background timer's rendering work. Pixel ratio is fixed at 1, multisample antialiasing is disabled, the starfield has 600 points, and panel backdrop blur is removed. Static buffers are reused across simulation updates. Agent matrices update when the camera or data changes rather than pulsing every frame.

Canvas data attributes expose the recent rendered frame rate, longest frame interval, and draw-call count for lightweight diagnostics. Samples include rendering cadence, not GPU timer-query measurements. The production bundle is served for the current local preview, avoiding development instrumentation and hot-reload overhead.

For the optimized preview:

```sh
npm run build
npm run preview
```

This serves http://127.0.0.1:5173. Stop the development server first if it owns that port. Production preview does not hot reload; rebuild and refresh after source edits. Use npm run dev when actively developing.

## Synvix backend

The backend adds SQLite event/state persistence, tenant-scoped viewer and ingestion authentication, WebSocket snapshots/recovery, replay, a read-only Cursor Cloud API/SSE adapter, signed GitHub webhooks and REST enrichment, official Grok Bot self-reporting through MCP/HTTP, and metadata-only OTLP HTTP JSON ingestion. No provider agent is launched or controlled.

Copy `.env.example` to `.env`, set separate viewer/ingestion tokens and desired provider credentials, run `npm run build`, then `npm start`. Backend and UI: http://127.0.0.1:4310. Live mode uses `/?mode=live#token=YOUR_VIEW_TOKEN`; plain `/` retains demo mode. Credentials are server-side only. See [docs/backend.md](docs/backend.md) for exact steps, connector limitations, multi-tenant setup and event contracts.

Verified with 24 automated tests and a clearly labeled synthetic fixture through the existing UI. The live fixture showed reported activity and unknown delivery/progress rather than simulated work, with a short render sample around 30 fps. Real account verification still requires the user’s Cursor/GitHub credentials and Grok Bot connector setup.
