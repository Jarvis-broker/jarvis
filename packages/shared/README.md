# packages/shared

Shared contracts between the **client** (desktop app) and any remote **HTTP
agent** wired up through the agent registry. Keeps the HTTP request/response
shapes from drifting.

- `contracts.ts` — agent_call args/result, revenue summary, health envelope.
