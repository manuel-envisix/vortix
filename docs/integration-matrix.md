# Integration research — 2026-11-10

The existing application is branded Vortix; Synvix names the backend requested in the integration specification. Its layout and rendering are retained. There was no existing backend or database.

| Source | Confirmed capability | Authentication | Implementation and limits |
|---|---|---|---|
| Cursor Cloud API v1 | Paginated agent discovery; full agent metadata; per-agent runs; run status, result metadata and pushed branches/PR URLs; resumable run SSE (`tool_call`, `status`, `result`) | Server-side Cursor API key, Basic or Bearer | Read-only discovery/reconciliation, bounded concurrent requests, optional metadata-only SSE; never create, steer or cancel agents. List agent lifecycle is distinct from execution run status. Account visibility determines discovery coverage. |
| Cursor managed Cloud hooks | Project `.cursor/hooks.json`: tool/file/shell, prompt/response lifecycle, subagent start/stop, stop | Synvix ingestion bearer token in the cloud environment | An opt-in bridge strips prompts, thoughts, commands, arguments, outputs and local paths before sending metadata. It does not install hooks into another repo. Conversation IDs are not automatically assumed equal to API agent IDs; explicit mapping is required when identifiers differ. |
| Cursor unsupported hooks | Managed Cloud lacks sessionStart/sessionEnd, IDE workspace/Tab hooks, before/afterMCPExecution and plugin hook loading | — | Never promise CLI hook behavior for Cloud. HTTP MCP tools report redacted outputs; only the tool envelope is needed. Hooks start after a writable environment exists. |
| Official xAI Grok Bot | Cloud teammate with custom MCP/API tooling | Synvix reporting token; product-side custom tool setup | `GrokBotAdapter` accepts explicit reports and an MCP reporting tool. No public automatic agent-discovery/monitoring API was verified from the product documentation reviewed. Reports are labeled `reported`, not observed internal execution. No Grok Build CLI, Responses API, self-hosted runtime, or Rakazo instrumentation is used. |
| Grok Bot Enterprise inference hooks | Signed security-policy frames containing conversation/tool context | Enterprise administrator and signing secret | Reviewed, intentionally not used as monitoring: frames can contain full conversation content, checks can add latency, and configuration can affect agent behavior. They are not complete tool/subagent telemetry. Default integration remains the metadata-only reporting tool. |
| Linear external evidence | Signed issue/comment/project webhooks and GraphQL metadata | Linear API/OAuth and webhook signing secret | A possible future task-evidence adapter, not internal agent monitoring. No Linear credentials or agent-task mappings were supplied; no connector is enabled or attribution invented. |
| GitHub REST + webhooks | Repositories, branches/commits, PRs/files/reviews, workflow runs/jobs/steps, checks, merges and deployments | Server-side GitHub token; per-tenant webhook HMAC secret | Correlate only with explicit PR URL, exact repository+branch, or repository+commit evidence. No attribution based on timing. GitHub events alone cannot establish an agent's unobserved internal tool activity. |
| OTLP HTTP/JSON | `invoke_agent`, `execute_tool`, explicit lifecycle log records; trace/span hierarchy | Ingestion bearer token | JSON traces/logs only, metadata allowlist; not a general-purpose collector, gRPC/protobuf and raw content are not accepted. Exported spans generally arrive after an operation ends. |

## Reference implementation inspection

Cloned under ignored `.research/`, read without executing their code:

- Agent Visualiser, commit `a474c3cfaeb36792627c05b6ac635e3ba777aa5c`: `src/shared/protocol.ts`, `src/shared/otel.ts`, `src/daemon/hub.ts`, `src/daemon/server.ts`, `src/daemon/otlp.ts`. Useful patterns: source normalization, bounded deduplication, session trees, snapshot-on-connect, semantic span mapping and metadata-only privacy. Synvix uses its own contracts and database.
- AgentSystemLabs Agent Office, commit `852e2ab28c4f3f31bffdf4b20353bd119c9d3270`: read `docs/agents.md`, `docs/how-it-works.md`, `docs/features.md`; inspected `src/server/grok.ts`, `cursor.ts`, `providers/grok.ts`, `workers/lifecycle.ts`. Its isolated GROK_HOME, hook helper, per-worker authenticated status and resume handling apply to locally launched CLI workers, not discovery of the user's official cloud Grok Bot.
- Munizada Agent Office, commit `228080bc0a8786b19e3eceebf416e2ceb02b3a16`: `server/index.mjs` and README; useful server-state snapshots and event streaming pattern, but no cloud-provider discovery substitute.

## Primary references

- https://prod.cursor.com/docs/cloud-agent/api/endpoints
- https://prod.cursor.com/docs-static/cloud-agents-openapi.yaml — downloaded and inspected; public beta v1, API specification version 1.0.0.
- https://prod.cursor.com/help/ai-features/cloud-agents
- https://cursor.com/docs/hooks — managed Cloud support matrix and hook input contracts.
- https://docs.x.ai/grok-bot/overview — custom MCP/API tooling.
- https://docs.x.ai/grok-bot/computer-and-apps — custom Remote HTTPS MCP connector and optional headers.
- https://docs.x.ai/grok-bot/inference-hooks — Enterprise security hooks, not enabled by Synvix.
- https://linear.app/developers/webhooks — externally observable task updates.
- https://github.com/JoelHutchinson/agent-visualiser
- https://github.com/AgentSystemLabs/agent-office
- https://github.com/Munizada/agent-office

## Verification boundary

Real provider verification requires the user's account credentials and enabled integrations. Automated tests use provider fixtures and local HTTP/WebSocket connections, never billable agent runs. The official Grok Bot reporting route is not equivalent to transparent monitoring: missed self-reports cannot be reconstructed as internal activity. Cursor v1 webhooks are documented as forthcoming; reconciliation and run SSE are used instead.
