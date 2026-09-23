# Agent Community

**The open-source opportunity router for communities.**

Route every request in your community to the people — and their agents — who can make it happen.

> People bring the judgment. Agents handle the coordination. The network learns from every collaboration.

[中文](README.zh-CN.md) · [Vision](VISION.md) · [Roadmap](ROADMAP.md) · [RFCs](RFC/README.md) · [Contribute](CONTRIBUTING.md)

## The question

Your community has 1,000 people. Someone brings an opportunity. Do you actually know who should get it?

Communities rarely have a people problem. They have a routing problem. Capability and demand are both there, but they meet by luck: a message in a group chat, an organizer who happens to remember the right member, a chain of DMs. The organizer becomes a human router, and that stops working long before the community stops growing.

## What it does

```mermaid
flowchart LR
  R[Request] --> U[Understand the need]
  U --> M[Match capabilities]
  M --> S[Community suggestions]
  S --> P[Agent pre-flight]
  P --> A[Human accepts]
  A --> Q[Squad]
  Q --> O[Reviewed outcome]
  O --> E[Capability evidence]
  E -.better matches.-> M
```

1. A request comes in from a member, a client or a lab project.
2. The network breaks it into the capabilities it needs.
3. It finds members who have those capabilities, from their confirmed profiles and past accepted work.
4. Other members, and their agents, suggest people and fill gaps.
5. The candidates' agents handle the first mile of coordination: availability, fit, constraints and missing inputs.
6. Humans decide. A squad forms and does the work.
7. The requester reviews the result.
8. Accepted work becomes evidence of who can do what, so the next match is better.

**A person here focuses on one thing: what they want.** They say it in a paragraph at the start and judge the outcome at the end; the coordination in between — making the request clear, inviting people, forming the squad — can be handed to their own agent ([RFC 0011](RFC/0011-one-focus-point.md)).

Members self-serve, and agents are optional. A member's agent works through a documented interface that tells it what it may do, what needs its principal's permission, and what it may never do. Only two things are never delegated: **committing** (accepting an invitation, promising time or money) and **judging** (accepting the outcome) ([RFC 0010 §7](RFC/0010-opportunity-router.md)).

**Agent Community is a working name**; branding is open in [RFC 0001](RFC/0001-name-and-positioning.md). The node deployed for the first pilot is called *Agent Network*.

## Where we are

**Direction set; routing runs as an in-memory demo.** On 2026-09-22 the maintainer repositioned the project from "a network of people and agents" to routing real opportunities ([RFC 0010](RFC/0010-opportunity-router.md)). A Phase 1 demo now exists: member agreement and profile drafting, requests with capability needs, explainable matching, community suggestions, pre-flight, human-only decisions, squads, review into verified evidence, an organizer dashboard, and the member-agent interface (manifest, HTTP API, MCP). It comes with an end-to-end evaluation that anyone's agent can join ([EVAL](docs/EVAL.zh-CN.md)). **A public demo with fictional members runs at https://agent-network-demo.zwteam.top**: visitors can join as guests and connect their own agents over MCP. The FlareMo-backed production node is not deployed yet.

What exists, verified on one machine and not yet deployed:

| Built and tested locally | Status |
| --- | --- |
| Community node: invitation-only membership, owner-restricted bootstrap, FlareMo sign-in, visibility rules, filtered change feed | Node process and a Cloudflare Worker + Durable Object build pass the same live suite against a local FlareMo |
| Eight core objects (Request, Capability, Workroom, Artifact, Attestation, …) stored in FlareMo through a structured extension | Real local integration: history, conflicts, atomic transactions, replay, isolation |
| Phase 2 preview: a member's own Codex CLI executes approved requests on their machine (register → claim, per-order consent, completion ≠ acceptance), with agent-written profiles | Verified with a simulated Codex binary; a real Codex run is pending |

Evidence, separated into simulated tests and real integration runs, is in the [local loop record](docs/LOCAL_LOOP.zh-CN.md). There is no public deployment, external member or federation yet.

**KOSX** is the first validation community. The pilot plan, with targets and stop criteria, is in [KOSX_VALIDATION_PLAN](docs/KOSX_VALIDATION_PLAN.zh-CN.md). If the request → people loop does not create value there, the project stops. The KOSX files in `examples/` are synthetic.

## Try it locally

Use Node.js 24. The only dependency is the exactly pinned `@a2a-js/sdk` 1.2.0.

```sh
git clone https://github.com/edison-land/agent-community.git
cd agent-community
npm ci
npm test                 # offline, simulated
npm run demo
npm run node:simulated   # community page with in-memory storage and fictional members
npm run eval             # end-to-end evaluation of the routing chain (about 3 s, fictional scenario)
npm run eval -- --external edison   # let your own agent (Codex, Claude Code, …) play Edison's agent
```

Live integration against a local FlareMo instance, the Worker build and the connector are documented in the [local loop record](docs/LOCAL_LOOP.zh-CN.md) and [RFC 0008](RFC/0008-cloudflare-deployment.md).

## Shape it

We share questions, prototypes, observations and changes in direction before building substantial functionality. See [the feedback loop](docs/BUILD_IN_PUBLIC.md).

- **Community organizers:** bring an opportunity that fell through the cracks. Who should have received it, and how would you have known?
- **Members:** what would make you confirm a drafted profile, accept an invitation, or suggest someone else?
- **Builders:** review the member-agent contract in [RFC 0010 §7](RFC/0010-opportunity-router.md). What would your agent need in order to act on it?

Use Issues for use cases and proposals, and pull requests for concrete changes. English and Chinese are both welcome. No coding is required to participate.

## Repository map

```text
VISION.md / ROADMAP.md     Product thesis and phased milestones
RFC/                       Proposals and decision history (0010 = current direction)
docs/                      Architecture, local evidence, deployment, validation plan
apps/node, apps/worker     Community node (Node process / Cloudflare Worker)
apps/connector             Member connector for Codex CLI (Phase 2 preview)
apps/a2a-client            Independent A2A client
packages/app               Shared Fetch handler for both node runtimes
packages/community         Business rules: membership, requests, review, visibility
packages/store             FlareMo object store client and read cache
packages/gateway           A2A gateway and connector API
protocols/                 Object and record schemas, A2A profile
examples/, test/           Synthetic fixtures, simulated and live test suites
```

Earlier experiments (FlareMo knowledge sharing and a sign-in prototype) remain in `apps/flaremo-demo`, `apps/login-demo`, [RFC 0003](RFC/0003-layering-and-flaremo-demo.md) and [RFC 0004](RFC/0004-flaremo-login.md).

## Stewardship and license

Initially maintained under **edison-land**. **ai-kosx** is a possible future GitHub organization home, subject to a later explicit transfer decision. Repository ownership is independent of community ownership. See [governance](GOVERNANCE.md) and [transfer notes](docs/REPOSITORY_TRANSFER.md).

[MIT licensed](LICENSE). No domain, hosted service, package namespace or visual identity is reserved by this repository.
