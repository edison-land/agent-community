# RFC 0003 — Layering and the FlareMo connector experiment

Status: Draft; local connector experiment authorized, production design pending
Date: 2026-09-21

Revision note: the knowledge-only FlareMo role below records the earlier experiment. The maintainer subsequently selected FlareMo as the target canonical core-object store via a structured extension in [RFC 0005](0005-core-objects-and-flaremo-store.md); [RFC 0006](0006-community-a2a-profile.md) now fixes the A2A profile baseline. Business ownership remains in Community; do not interpret this historical draft as a second writable primary database.

## Outcome

Demonstrate a community member sharing selected knowledge with another member's agent, updating it, and withdrawing access. The user confirmed that “Flannel” refers to FlareMo at https://github.com/realchendahuang/FlareMo.

## Six logical layers

| Layer | Owns | Initial implementation direction |
| --- | --- | --- |
| 1. Experience | Member profiles, capability cards, workrooms, resource views | One web application; demo is a local result viewer |
| 2. Collaboration | Requests, acceptance, delegation, artifact review | Application services; durable state required before real execution |
| 3. Identity and policy | Community memberships, human/agent bindings, scoped revocable grants | Platform-owned records; deny by default |
| 4. Protocols and connectors | A2A agent handoffs, MCP tools, FlareMo API translation | Separate adapters behind policy checks |
| 5. Data | Platform facts, resource references, authoritative knowledge and derived search | Platform database separate from FlareMo's D1/R2 data |
| 6. Background operation | Task workers, connectivity, event delivery, indexing, audit and recovery | Start in one deployable node with an outbox; split only when justified |

These are responsibility boundaries, not six services. Authentication and authorization apply across entry points. FlareMo is an external knowledge application accessed through layer 4; it retains ownership of its content, storage and permission checks. The platform retains community/agent/permission/task facts.

## Protocol reuse

- Agent to agent: evaluate the official [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js) (`@a2a-js/sdk`, Apache-2.0). Its current documentation describes protocol v1.0, Agent Cards, task state/artifacts, streaming, cancellation and optional v0.3 compatibility. Choose and lock an SDK version against a real peer before implementing. Wrap the existing runtime with an A2A adapter; do not invent a competing task protocol.
- Agent to tools: evaluate the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (MIT). Match a stable release and supported transport to FlareMo's advertised MCP protocol. Community tools would expose permission-checked discovery, request submission and resource reads. MCP connectivity does not provide an always-running agent or community authorization.
- Platform to knowledge: the present experiment uses Memos-compatible REST so response codes and visibility transitions can be tested deterministically. A future MCP adapter may use FlareMo's memo `/mcp`; `/memory/mcp` remains personal memory.
- Protocol specification: [A2A](https://github.com/a2aproject/A2A). These projects define interoperability, not community membership or human responsibility. A claimed Agent Card is metadata until principal binding and endpoint control are verified.

No SDK dependency is added in this experiment. The two demo actors are synthetic identities; there is no A2A server, MCP client, LLM inference, ownership claim flow or production task engine here.

## FlareMo contract evidence

Reviewed upstream revision: `e42d98fb65a505dacd9bac6501d3df0344832e7f`.

- [REST routes](https://github.com/realchendahuang/FlareMo/blob/e42d98fb65a505dacd9bac6501d3df0344832e7f/apps/worker/src/routes/memos-current/memo-routes.ts): create/read/update and soft-delete memos at `/api/v1/memos`; camelCase DTOs; PRIVATE/PROTECTED visibility; PATCH supports updateMask.
- [Team model](https://github.com/realchendahuang/FlareMo/blob/e42d98fb65a505dacd9bac6501d3df0344832e7f/docs/team-mode.md): one team per deployment, team memos shared with active members; no arbitrary workroom ACL or shared Agent Memory.
- [Memory](https://github.com/realchendahuang/FlareMo/blob/e42d98fb65a505dacd9bac6501d3df0344832e7f/docs/agent-memory.md): source_agent is a label, not registered identity; queries are user-scoped.
- [Webhook implementation](https://github.com/realchendahuang/FlareMo/blob/e42d98fb65a505dacd9bac6501d3df0344832e7f/packages/domain/src/memos-webhooks.ts): per-user delivery, signing, retries and an outbox.

Connect one community to one separately configured FlareMo instance initially. PROTECTED means the whole FlareMo team, not selected workroom participants. Keep narrower documents private until a finer-grained sharing design exists. Use independent ordinary test accounts; never share an owner PAT across agents. A FlareMo PAT inherits user authority; our gateway must constrain what an agent may request.

## Experiment

Create synthetic private memo as member A → member B denied → publish to team → B reads → edit content → B sees new content → return to private → B denied → optional soft-delete the same fixture.

The local mock additionally revokes B's token and injects transport failures. It uses the same HTTP connector as the live runner but implements only the tested REST subset. A passing mock proves our client behavior, not real FlareMo behavior.

## Real-time path, deferred

Start with a fresh authorized GET for each resource access. Later, accept signed change events, persist event IDs for duplicate suppression, fetch the latest authorized revision rather than trusting event snapshots, invalidate on access changes, and reconcile after disconnects. SSE can update the UI. A2A task events update platform task state, while runtime heartbeats update availability. Source writes and derived indexing are separate states. Neither webhook nor SSE synchronization is implemented by this demo.

## Acceptance and next decision

Local HTTP checks pass, then an administrator authorizes a staging instance and two ordinary accounts. Run the live fixture sequence and record deployment revision, observed outcomes and failures. No automatic production rollout. If live permissions or DTOs differ, repair the adapter/mock and document the mismatch before adding A2A execution. Restore/revocation, real webhook ordering, attachments and indexing latency require subsequent tests.
