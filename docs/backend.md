# Synvix backend: setup and verified boundaries

The existing Vortix-branded interface is retained. Only data plumbing, source labels and unavailable-value handling change. Demo and live data never mix. The backend monitors; it cannot launch, steer, cancel, merge, or deploy agents.

## Start locally

Requires Node 24 or later with built-in `node:sqlite` (currently emits an experimental-feature warning), and the existing npm dependencies.

1. Copy `.env.example` to `.env` locally. Generate **two different** random tokens with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Put them in `SYNVIX_VIEW_TOKEN` and `SYNVIX_INGEST_TOKEN`. Do not paste provider credentials into chat or use `VITE_` variables.
2. Add the provider credentials described below. Missing provider keys disable that outbound connector, not demo mode.
3. Run `npm run build`, then `npm start`. The backend serves the built frontend and `/api/*` at **http://127.0.0.1:4310**. It binds loopback only.
4. Demo: open `/`. Live: open `/?mode=live#token=YOUR_VIEW_TOKEN`. The browser exchanges the viewer token for an eight-hour HttpOnly SameSite cookie and removes the fragment. The ingestion token is never given to the browser.
5. For development, run `npm run server` and `npm run dev` separately. Vite proxies HTTP and WebSocket `/api` requests to port 4310. The production `npm run preview` proxy also works after restarting it with the updated config.

With no viewer/ingestion tokens, the service starts with zero tenants. `/api/health` and demo work; live APIs reject access rather than creating an anonymous tenant or showing fake agents.

The live UI displays up to 100 agents to preserve its rendering budget. The backend retains all ingested agents and event history. Cursor discovery is bounded by `SYNVIX_MAX_AGENTS` (default 100). No agent amount control is added to the UI.

## What you need to provide

| Connection | Required configuration | Optional / limitations |
|---|---|---|
| Cursor Cloud | `CURSOR_API_KEY` for the account whose agents should be visible | Read-only API v1 discovery/reconciliation; user/service account scope determines visibility. No agent is launched for testing. Up to `SYNVIX_CURSOR_STREAMS` active runs receive tool-envelope SSE (default 5); all discovered agents receive polling. |
| GitHub | `GITHUB_TOKEN`, exact comma-separated `GITHUB_REPOSITORIES`, and `GITHUB_WEBHOOK_SECRET` for webhooks | Fine-grained read permissions for repository metadata, contents, PRs, Actions and checks as applicable. Only grant repository access needed for monitoring. Webhooks need an HTTPS-reachable backend. |
| Official xAI Grok Bot | Add the custom MCP connector described below, with a Synvix ingestion token | No xAI Responses API key or Grok CLI login is used. Reported activity is explicit self-reporting, not discovery of hidden sessions or internal tools. |
| Cursor hook bridge | Copy the bridge and merge the example hooks into the target repo; set its ingestion URL/token in the cloud environment | Hooks cannot reach your laptop's loopback address. Use an authenticated HTTPS endpoint, reachable from the cloud environment. This repo does not modify another project's hooks or change agent permissions. |

No cloud deployment or public exposure is performed by setup. Put an authenticated HTTPS reverse proxy in front of the loopback service when remote hooks need access, and add its exact browser origin to `SYNVIX_ORIGINS`. Keep viewer and ingestion tokens separate. Supply HTTPS custom headers through the product's secure connector configuration.

### Cursor Cloud

The adapter discovers existing agents, including those created outside this dashboard **if returned by the authenticated account's API**. It paginates `GET /v1/agents`, reads durable details, run state and a bounded initial run history. New agents are discovered on reconciliation (default 30 seconds). Polling is sequential per connector with bounded request concurrency and exponential backoff, honoring Retry-After / GitHub reset headers. Failures leave last-known state intact and are visible in `/api/connectors`.

Run SSE is metadata-only: tool identity, tool lifecycle and run state; assistant and thinking text, tool arguments, full outputs and final response content are discarded. A persisted Last-Event-ID resumes each monitored run. An expired stream falls back to run reconciliation. Unknown tools do not become “coding” by default. Activity classified from a tool name is **inferred**, while the underlying tool execution and run status remain **observed**.

For additional hooks, copy `scripts/cursor-hook.mjs` to the target repository and **merge** `examples/cursor-hooks.json` into its `.cursor/hooks.json`. Existing hook configuration must be preserved. Set:

```text
SYNVIX_INGEST_URL=https://your-synvix-host
SYNVIX_INGEST_TOKEN=<ingestion token>
SYNVIX_REPOSITORY=owner/repo
```

The helper sends an explicit metadata allowlist from a detached, short-lived process with a 1.2-second network timeout, so delivery does not block the hook. Pre-hooks return the neutral protocol response (`permission: allow`, or `continue: true` for prompt submission); this permits the normal flow of that hook and does not bypass native tool approvals or other hooks. Post-hooks return `{}` and never inject context, tool outputs or follow-ups. Do not register both generic tool hooks and shell-specific hooks for the same operations; the example uses generic hooks. It intentionally does not register `afterAgentThought` or `afterAgentResponse`, because raw reasoning/response content is unnecessary for monitoring.

Cloud hook `conversation_id` is preserved. It is **not assumed** to be the Cloud API's durable agent ID. If your environment supplies verified API IDs, set `SYNVIX_CURSOR_AGENT_ID` and `SYNVIX_CURSOR_RUN_ID` in the bridge environment. Otherwise, a separate `conversation:<id>` identity is used. To explicitly associate a conversation after verification, POST `{ "conversation_id": "…", "agent_id": "bc-…" }` to `/api/cursor/aliases` with the ingestion token. Future events use that mapping; previously recorded identities are not silently rewritten.

A subagent start hook reports spawn intent as inferred/unknown until execution is observed. If a subagent-stop payload lacks a stable child ID, it is ignored rather than completing the parent. Documented durations and bounded failure categories are captured without raw error messages.

Cross-channel tool deduplication uses the verified provider+agent+run+call+event identity. When shared identifiers are unavailable, raw source events are retained rather than incorrectly merging unrelated activity. OTLP trace IDs/span IDs are scoped per tenant and trace.

### Official Grok Bot

In Grok Bot, choose **Connect apps → Add a custom connector → Remote HTTPS**. Set Server URL to `https://your-synvix-host/api/mcp` and the optional HTTP header `Authorization: Bearer <ingestion token>`. This is a stateless MCP HTTP tool server, not OAuth; use custom header authentication supported by the product.

Ask the Bot to use `report_activity` for explicit start/wait/resume/complete/failure milestones, with stable bot/session/run IDs and a unique `event_id` reused on retries. Optional repository, branch, PR URL, parent ID, sanitized tool name/provider and duration can be reported when known. Do not send prompts, chain-of-thought, secrets, commands, tool arguments or outputs. `examples/grok-report.json` is the equivalent POST body for `/api/grok/report`.

Reports are forcibly attributed to `grok_bot`, `grok_report`, `reported`. They cannot claim to be observed provider telemetry by changing those fields. The connector does not automatically observe every Grok Bot action, discover all Bots, guarantee self-reporting, or infer unreported progress. Parentage is shown only when reported.

Enterprise inference hooks were researched but deliberately not wired in: they are a security-policy path, may deliver whole conversation context, can add latency and can affect tool/model execution. That conflicts with passive, metadata-only monitoring. GitHub can provide corroborating delivery evidence. Linear issue webhooks could provide future task evidence, but no Linear adapter is enabled in this version.

### GitHub

Configure a webhook URL `https://your-synvix-host/api/webhooks/github/local`, using `GITHUB_WEBHOOK_SECRET`. Choose JSON payloads and subscribe to pull requests, pull request reviews, push, workflow runs, check runs/check suites, deployments and deployment statuses. Repository names must be in the explicit tenant allowlist.

HMAC-SHA256 is verified against raw request bytes. Correlation uses **exact repository plus known PR URL, branch or commit SHA**; matching time, author names or similar task text is never enough. Fork branches are not assumed to belong to the base repository. REST polling supplements webhooks for known agent PRs and exact branch matches; polling loads PR metadata/files/reviews, commits and a bounded set of current workflow jobs/steps. Job/step conclusions are CI metadata, not parsed raw logs or guaranteed individual test-case results. Missing provider data stays unavailable.

No GitHub mutation endpoint is implemented. CI failure does not mean the agent itself failed. Multiple workflow results are retained as pipeline stages for a known commit. Initial REST enrichment is intentionally bounded (100 files/reviews, 20 candidate workflow runs and five workflows per PR per cycle); large histories remain available from GitHub rather than being silently described as complete imports.

## Contracts

The strict event allowlist is in `server/events.ts`. Required: event_id, provider, agent_id, event_type, timestamp, source, confidence. Optional identifiers distinguish sessions, runs, parents, tasks and repositories; state/activity evidence is separate. Unknown input fields are discarded before persistence. Task summaries must be explicit metadata, not raw prompts.

| Endpoint | Authorization | Purpose |
|---|---|---|
| `GET /api/health` | Public | Service readiness and whether any tenants are configured; no secrets |
| `POST /api/session` | Viewer Bearer | Obtain HttpOnly browser session |
| `GET /api/snapshot` | Viewer/session | Current live state and recent events |
| `GET /api/events?after=0&limit=1000&agent=external-id&run=run-id` | Viewer/session | Persistent, tenant-scoped metadata history; filters optional |
| `GET /api/replay` | Viewer/session | Same event replay contract |
| `GET /api/connectors` | Viewer/session | Configured/connected/error diagnostics, backoff, stream count |
| `WS /api/ws` | Viewer/session + allowed Origin | Initial snapshot, coalesced snapshots at most twice per second, recovery |
| `POST /api/ingest` | Ingestion Bearer | One normalized event or batch of up to 100 |
| `POST /api/hooks/cursor` | Ingestion Bearer | Sanitized Cloud hook records |
| `POST /api/cursor/aliases` | Ingestion Bearer | Explicit conversation→API agent identity binding |
| `POST /api/grok/report` | Ingestion Bearer | Official Grok Bot self-reports |
| `POST /api/mcp` | Ingestion Bearer | initialize, tools/list, tools/call(report_activity), ping |
| `POST /api/otlp/v1/traces` and `/logs` | Ingestion Bearer | OTLP HTTP JSON metadata; at most 1000 spans, no gRPC/protobuf/gzip |
| `POST /api/webhooks/github/:tenant` | HMAC signature | GitHub evidence |

WebSocket connect sends `{ "type": "snapshot", "snapshot": ... }`. To recover raw missed events, send `{ "type": "subscribe", "after": 123 }`; the response includes `recovery.events`, cursor and `more`, followed by a current snapshot. Page `/api/events` until caught up if `more` is true. The frontend consumes current snapshots and retains the last 60 events; full history is in SQLite/replay. Slow clients over 1 MiB of queued data are disconnected and can reconnect. Sessions expire; reconnect with the viewer-token URL if needed.

SQLite WAL stores sanitized events, current materialized state, stable project IDs and resume cursors. Both event insertion and state updates commit atomically. Out-of-order events remain in history but do not regress newer execution state. Delivery updates have separate ordering from run state. Completed agents are retained. Back up `.local/synvix.sqlite` using SQLite-aware backup procedures; include WAL files if copying an active database. Credentials are not stored in it.

### Multiple tenants

Set `SYNVIX_TENANTS_FILE=synvix.tenants.json`. The ignored file contains an array of `{id, viewToken, ingestToken, cursorKey?, githubToken?, githubSecret?, repositories:[]}`. All scope tokens must be distinct. Database keys, ingestion, snapshots, WebSocket sessions, aliases and replay are tenant-scoped. A client cannot switch organizations by adding a query parameter or WebSocket message field. This provides tenant-wide access, not per-project RBAC or public user registration.

## Verification and remaining user-supplied dependencies

`npm test` covers simulation plus schema privacy, persistence/restart, tenant isolation, out-of-order reconciliation, hierarchy, failure duration, Cursor discovery pagination and rate limiting, SSE framing, webhook HMAC, evidence-based correlation, MCP reporting, duplicate channels and WebSocket recovery.

Real Cursor Cloud/Grok Bot/GitHub account sessions have **not** been verified without your credentials and remote connector configuration. API fixtures and explicitly labeled local integration fixtures are not proof of live provider access. Once configured, verify discovery via `/api/connectors`, compare a known Cursor run/PR to the UI, send a Grok Bot report through the configured connector, and confirm a real signed GitHub delivery and reconnect/restart history. No backend process launched a billable agent or changed a provider account.
