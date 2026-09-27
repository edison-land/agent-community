# Roadmap

Milestones describe observable outcomes, not promised dates. Direction: [RFC 0010](RFC/0010-opportunity-router.md) (2026-09-22). Each phase has an exit test; if Phase 1 does not create value in KOSX, the project stops rather than moving on.

## Phase 1 — Make one community useful (request → people)

| Step | Status | Exit evidence |
| --- | --- | --- |
| Foundations: community node, invitation-only membership, FlareMo sign-in, visibility rules, the eight objects in FlareMo, review records, Cloudflare Worker build | Built and verified locally; not deployed | See [local loop record](docs/LOCAL_LOOP.zh-CN.md) |
| Member agreement and consent records | Built; in the evaluation (RFC 0010 §6) | Members sign before any profile drafting; withdrawal removes drafted data |
| Member profiles, drafted from community activity and confirmed by the member | Built; in the evaluation | Most members in the pilot confirm their draft with light edits |
| Requests with capability breakdown, rewards and source | Built; one paragraph is enough, and matching is by meaning | Requesters accept or adjust the breakdown |
| Matching with reasons, plus community suggestions | Built; reasons quote the profile entry that matched | Candidates understand "why me"; suggestions are attributed |
| Pre-flight, accept or decline, squad with roles | Built; a squad can still take someone who accepts late | A request reaches a person who accepts, without the organizer relaying messages by hand |
| Review, capability evidence, collaboration edges, organizer dashboard | Built; in the evaluation | Accepted work updates profiles; dashboard shows opportunities → matches → squads → deliveries |
| Member-agent interface: onboarding doc, `/.well-known/agent-network.json`, `/api/agent/v1`, MCP tools, inbox, scoped tokens | Built; verified by the end-to-end evaluation (RFC 0010 §7) | A member's own agent drafts a profile, suggests a candidate and answers pre-flight, and all of it is attributed and confirmed where required |
| One focus point: a request is one paragraph, what is still unclear is named, and a member can delegate the coordination in between to their own agent | Built and verified ([RFC 0011](RFC/0011-one-focus-point.md)) | The requester never clicks through candidate selection or squad forming; invitations sent by an agent are attributed to it, and committing and judging stay with the person |
| KOSX pilot | Planned ([plan](docs/KOSX_VALIDATION_PLAN.zh-CN.md)) | Targets in the plan are met, or the stop criteria are triggered and the result is published |

## Phase 2 — Make agents useful (people + agents do the work)

| Step | Status |
| --- | --- |
| Per-order execution on the member's own machine (Codex CLI connector, register → claim, per-order consent, completion ≠ acceptance) | Built and verified locally with a simulated Codex ([RFC 0007](RFC/0007-local-closed-loop.md), [RFC 0009](RFC/0009-agent-profile-and-onboarding.md)); a real Codex run is pending |
| Memory capsules and per-order sandbox (what makes one member's agent different from another's, without exposing the rest of their machine) | Proposed; sandbox limits measured ([local loop record](docs/LOCAL_LOOP.zh-CN.md) §⑧) |
| Automated pre-flight and agent-to-agent negotiation over A2A | A2A 1.0 gateway built ([RFC 0006](RFC/0006-community-a2a-profile.md)) |

## Phase 3 — Connect communities

Route a request one community cannot meet to other consenting communities. Research only; no federation protocol until Phase 1 and Phase 2 evidence exists.

## Next decision gate

The KOSX pilot. Before it starts:
- the FlareMo extension gains the new record kinds, and the administrator patch is regenerated;
- the community brain provides profile-drafting signals for consenting members;
- the member agreement is written and reviewed.

Deployment steps are in [DEPLOY_CLOUDFLARE](docs/DEPLOY_CLOUDFLARE.zh-CN.md) and [the FlareMo administrator handoff](docs/FLAREMO_ADMIN_HANDOFF.zh-CN.md).

## Measurement

Record opportunities, matches, squads, deliveries, verified capabilities, suggestions, invitation acceptance and time to first accepted match, together with sample size and limitations. Do not report synthetic fixtures, registered agents or generated messages as traction.

## Deferred

Payments, global ranking, federation protocols, unattended delegation, hosted billing and an app marketplace each need their own evidence and decision. No launch date is committed.
