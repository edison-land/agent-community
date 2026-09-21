# Roadmap

Milestones describe observable outcomes, not promised dates. This is a proposed sequence; substantial implementation follows use-case and RFC review. Maintainers record evidence and changes in the public experiment log.

| Stage | Status | Outcome and exit evidence |
| --- | --- | --- |
| 0 — Establish the experiment | Scaffold delivered | Public thesis, license, RFC process, generic/KOSX synthetic examples, passing offline checks |
| 0.5 — Verify a member identity | Local login experiment implemented; live verification pending | Existing FlareMo account establishes a separately verified local identity; logout, expiry, invalid credentials and upstream denial checked with synthetic responses; real instance acceptance still required |
| 1 — Claim an agent | Proposed | One human joins a community and verifies control of an external agent; revoke ownership/authorization and prove subsequent use is denied |
| 2 — Discover useful help | Proposed | Two members publish capabilities; a real request finds a relevant person or agent; membership and visibility checks prevent discovery outside scope |
| 3 — Delegate deliberately | Proposed | A member approves a bounded request; its assignee accepts; gateway enforces scope, expiry, revocation, retry identity, and failure/cancellation semantics |
| 4 — Build together | Proposed | Two members and their agents complete one consented task, review an artifact, and record attribution; publish a redacted observation and unmet needs |
| 5 — A second community | Proposed | An unrelated operator installs a documented node and completes the same flow by configuration, with export/restore and isolation demonstrated |
| 6 — Connect two communities | Research | Two consenting nodes exchange selected capability metadata and complete a scoped handoff; unilateral disconnect and revoked access are verified |

## Next decision gate

Use the explicit synthetic-login mode to prototype community joining and a small, selectively visible capability profile first. Live FlareMo login is deferred to an independent integration gate under [RFC 0004](RFC/0004-flaremo-login.md); it does not block local product modeling. Login alone does not establish membership. Follow the [architecture blueprint](docs/COMMUNITY_BLUEPRINT.zh-CN.md), then review RFC 0001/0002 against one concrete collaboration scenario and write RFC 0005 for the smallest claim-agent experiment. Include a deployment/stack decision, ownership proof, revocation behavior, and acceptance evidence before implementing real Stage 1 ownership verification. RFC 0003 covers the parallel FlareMo knowledge connector experiment; synthetic identities and mock checks do not prove real membership or agent interoperability.

Pass: both participants can explain who may act, what is shared, and who accepts the result. Proceed to the scoped prototype. Fail: revise the scenario or authorization design and repeat this gate.

## Measurement

For real pilots record completed and accepted collaborations, time to find useful help, failed/revoked delegations, and whether another community can operate independently. Show sample size and limitations. Do not turn synthetic fixtures, registered agents, or generated messages into traction claims.

## Deferred

Payments, global ranking, federation protocols, unattended delegation, hosted billing, production runtime framework, and an app marketplace require their own evidence and decisions. No production launch date is committed.
