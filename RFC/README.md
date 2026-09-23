# Requests for Comments

Use RFCs for material product or architecture decisions. Small fixes do not require an RFC.

Copy [0000-template.md](0000-template.md), choose the next available number, and open a PR. Link the underlying use case, alternatives, risks, acceptance evidence, and unresolved questions. Discussion belongs on that PR or a linked Issue. Contributors may write in English or Chinese.

Lifecycle: **Draft → In review → Accepted / Rejected / Withdrawn → Superseded**. The maintainer records the decision and rationale in the file before merge. Accepted designs can change through a new RFC that links to and supersedes the earlier decision. Approval of a proposal does not imply that its implementation has shipped.

| RFC | Status |
| --- | --- |
| [0001 — Name and positioning](0001-name-and-positioning.md) | Draft; positioning superseded by RFC 0010, naming still open |
| [0002 — Community and agent boundaries](0002-community-and-agent-boundaries.md) | Draft |
| [0003 — Layering and FlareMo demo](0003-layering-and-flaremo-demo.md) | Draft; local experiment implemented |
| [0004 — FlareMo login](0004-flaremo-login.md) | Accepted for local experiment; live verification pending |
| [0005 — Core objects and FlareMo storage](0005-core-objects-and-flaremo-store.md) | Draft protocol; FlareMo extension implemented in an independent local copy and verified against local FlareMo (see RFC 0007) |
| [0006 — Community A2A profile](0006-community-a2a-profile.md) | Draft profile; SDK 1.2.0 gateway and independent client verified locally (see RFC 0007) |
| [0007 — Local closed loop](0007-local-closed-loop.md) | Accepted for the local experiment; agent ownership proof, connector protocol, per-order authorization |
| [0010 — Opportunity router (repositioning)](0010-opportunity-router.md) | Accepted as product direction (2026-09-22); Phase 1 designed, not implemented |
| [0009 — Agent profile, one-command onboarding and memory modes](0009-agent-profile-and-onboarding.md) | Accepted by maintainer request; verified locally with a simulated Codex (Node and Worker builds); real Codex pending |
| [0011 — One focus point](0011-one-focus-point.md) | Accepted by maintainer request (2026-09-23); implemented, verified by tests, the end-to-end evaluation and a real browser |
| [0008 — Cloudflare deployment](0008-cloudflare-deployment.md) | In review; Worker + Durable Object build verified under `wrangler dev --local`, not deployed; online FlareMo extension pending its administrator |
