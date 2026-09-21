# Roadmap

Milestones describe observable outcomes, not promised dates. This is a proposed sequence; substantial implementation follows use-case and RFC review. Maintainers record evidence and changes in the public experiment log.

| Stage | Status | Outcome and exit evidence |
| --- | --- | --- |
| 0 — Establish the experiment | Scaffold delivered | Public thesis, license, RFC process, generic/KOSX synthetic examples, passing offline checks |
| 1 — Claim an agent | Proposed | One human joins a community and verifies control of an external agent; revoke ownership/authorization and prove subsequent use is denied |
| 2 — Discover useful help | Proposed | Two members publish capabilities; a real request finds a relevant person or agent; membership and visibility checks prevent discovery outside scope |
| 3 — Delegate deliberately | Proposed | A member approves a bounded request; its assignee accepts; gateway enforces scope, expiry, revocation, retry identity, and failure/cancellation semantics |
| 4 — Build together | Proposed | Two members and their agents complete one consented task, review an artifact, and record attribution; publish a redacted observation and unmet needs |
| 5 — A second community | Proposed | An unrelated operator installs a documented node and completes the same flow by configuration, with export/restore and isolation demonstrated |
| 6 — Connect two communities | Research | Two consenting nodes exchange selected capability metadata and complete a scoped handoff; unilateral disconnect and revoked access are verified |

## Next decision gate

Maintainer: review RFC 0001 and RFC 0002 with concrete participant feedback, select one collaboration scenario, and write RFC 0003 for the smallest claim-agent experiment. Include a deployment/stack decision, ownership proof, revocation behavior, and acceptance evidence before implementing Stage 1.

Pass: both participants can explain who may act, what is shared, and who accepts the result. Proceed to the scoped prototype. Fail: revise the scenario or authorization design and repeat this gate.

## Measurement

For real pilots record completed and accepted collaborations, time to find useful help, failed/revoked delegations, and whether another community can operate independently. Show sample size and limitations. Do not turn synthetic fixtures, registered agents, or generated messages into traction claims.

## Deferred

Payments, global ranking, federation protocols, unattended delegation, hosted billing, production runtime framework, and an app marketplace require their own evidence and decisions. No production launch date is committed.
