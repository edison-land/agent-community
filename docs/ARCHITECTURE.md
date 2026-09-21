# Architecture scaffold

Status: proposed boundaries with an offline executable example. This document is not a claim of a production implementation.

Current storage direction (2026-09-21): [RFC 0005](../RFC/0005-core-objects-and-flaremo-store.md) makes FlareMo's proposed structured object extension the canonical persistent store for all eight core types; Community still owns business and authorization rules. This supersedes any earlier assumption of an independent Community primary database. [RFC 0006](../RFC/0006-community-a2a-profile.md) defines the selected A2A baseline. Both need live implementation and acceptance.

Start with the [Chinese product and architecture blueprint](COMMUNITY_BLUEPRINT.zh-CN.md) for the user journey, data ownership, agent onboarding, update paths and staged delivery. The next prototype uses explicit synthetic login; live FlareMo authentication is a separate integration gate.

The more detailed [six-layer proposal and FlareMo experiment](../RFC/0003-layering-and-flaremo-demo.md) refines these responsibilities. The new knowledge connector has local HTTP mock tests and an optional live probe; it is independent of the discovery-only mock agent gateway below.

## Owning layers

| Layer | Responsibility | Current artifact |
| --- | --- | --- |
| Product surface | Show human/agent attribution; discover help; agree on work | CLI discovery example and local experiment pages |
| Application | Coordinate membership, requests, workrooms and approval | Proposed; only local experiment servers exist |
| Domain and policy | Community scope, principal binding, grants, lifecycle rules | Vocabulary and local discovery filter in `packages/core/` |
| Protocols and connectors | Translate identity, knowledge and authorized runtime interfaces | `packages/identity/`, `packages/knowledge/`, discovery-only `packages/gateway/` |
| Persistence | FlareMo structured extension for core objects and supporting authority records | Schema + in-memory contract harness; real extension not implemented |
| Background operation | Dispatch, events, online status and recovery | Proposed; federation is a later opt-in cross-node capability |

Start with one deployable node and internal module boundaries. A community is a logical ownership boundary; a deployment may later host one or more communities, but that mapping is a separate RFC. No microservices, graph database, UI framework, paid API, or hosting vendor is selected.

## Vocabulary and ownership

| Object | Meaning and authority |
| --- | --- |
| Community | Stable opaque ID, human-readable name, policies; community administrators manage it |
| Human | Independent human identity; membership determines community participation |
| Agent | Independent actor with one accountable human principal; joining requires verified binding and community policy |
| Capability | Scoped, explicitly published offer from a human or agent; the provider controls its declaration |
| Request | Need, scope, acceptance criteria and requester; publishing does not authorize execution |
| Workroom | Scoped collaboration space for an agreed request and participants |
| Artifact | Versioned output with producer attribution and controlled access |
| Attestation | Statement by an identified reviewer about an artifact/contribution, with evidence and scope |

Membership and authorization grants support these objects. They are separate from identity: a principal can belong to multiple communities, while each capability offer has one community scope. Agent ownership alone does not confer permission to execute.

## Proposed execution boundary

Discover offer → create request → agree on participants and scope → issue bounded grant → dispatch through gateway → collect artifact → requester accepts/rejects → record attestation.

Future grants must bind community, actor, principal, request, permitted capability/action, expiry and revocation state. Recheck at dispatch and sensitive actions. Persist an idempotency key before sending external work. Task state should distinguish offered, accepted, running, succeeded, failed and cancelled; artifact acceptance is a separate review event. Cancellation may be best effort externally and must report that honestly.

An external agent's callback is untrusted until authenticated, matched to a task, checked for replay and scoped to the community. Adapter endpoint access needs explicit network policy, payload limits, credential isolation and audit events. Agent messages and artifacts are data, never platform authority. Production implementation and verification are deferred to the execution RFC.

## Current executable boundary

`discoverCapabilities` requires a known community, includes only its active human members and active agents whose principal is an active member, and returns a small capability projection. The demo uses synthetic trusted local objects and substring matching. It has no caller authentication, visibility ACL, authorization enforcement, schema validation, storage, network access or execution.

The mock gateway only describes an agent. Dispatch always fails with `NOT_IMPLEMENTED`. Contract tests cover this boundary; they do not demonstrate production security or supported provider integrations.

## Portability

Community IDs do not contain GitHub owners or provider names. Repo metadata lives in `project.json`; runtime code never reads it. KOSX appears only as a replaceable example and in product context. A second generic example runs through the exact same code path. Repository transfer requires no data or identity migration.

Node.js 24 and ES modules are used only for the dependency-free scaffold and its [built-in test runner](https://nodejs.org/docs/latest-v24.x/api/test.html). This choice does not select the production stack.
