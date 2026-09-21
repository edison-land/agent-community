# RFC 0004 — FlareMo login experiment

Status: Accepted for a local experiment; production authentication remains undecided
Date: 2026-09-21
Decision basis: the maintainer requested FlareMo login as the next integration. This records the narrow boundary for that experiment, not approval for hosted deployment or agent execution.

## Outcome and boundary

An existing FlareMo member can verify their identity in a local Community demo. A fixed, operator-configured FlareMo origin is the only credential destination. No KOSX instance is a runtime default. No new dependencies or production database are introduced.

The local backend forwards a username/password once to `/api/v1/auth/signin`, then independently verifies the returned access token with `/api/v1/auth/me`. Only this second result establishes identity. Passwords are not persisted or logged. Tokens and upstream cookies stay in process memory; the browser receives an opaque HttpOnly, SameSite=Strict local session cookie. Bind only to loopback HTTP for this experiment; hosted use requires a separate HTTPS/session design.

Identity is keyed by provider origin plus the upstream immutable user resource name, never an email or display name. The current mapping is deterministic and experimental, not a durable production human ID. Login does not create membership, import knowledge, register an agent, or grant execution. No tokens are supplied to agents.

## Origin, session and failure policy

- Exact Host and mutation Origin checks prevent external sites from driving the local server. The actual local origin is forwarded upstream, never replaced by FlareMo's own origin to bypass its trusted-origin policy. The operator must allow the local origin in `FLAREMO_TRUSTED_ORIGINS`.
- Fixed HTTPS upstream origin only, no arbitrary browser-supplied URLs, credentials in URLs, redirects, or automatic retries. Requests have deadlines and size limits; errors exclude upstream bodies and secrets.
- Every authenticated page request checks `/auth/me` again and compares the identity with the original binding. Upstream rejection, expiry or identity change clears the local session; upstream unavailability denies access without pretending the identity is verified.
- Sessions expire no later than the upstream access token or one hour, whichever is earlier. No automatic refresh. Restart discards sessions; login again after expiry. Bounded local login attempts are an experiment safeguard, not production anti-abuse infrastructure.
- Logout always removes the local session and attempts upstream signout using the access token and the cookies issued by this experiment. Report whether the upstream request succeeded. This does not claim immediate invalidation of all existing FlareMo tokens or other device sessions.

## Alternatives

OAuth/OIDC authorization redirects would keep passwords on FlareMo's page and are preferable for a public multi-application service, but the audited configuration does not enable an identity-provider plugin. PAT binding is useful for a knowledge connector but is not the ordinary username/password login experience requested here. Reusing broad parent-domain cookies couples unrelated applications and is not proposed.

## Evidence and acceptance

Upstream reviewed: `e42d98fb65a505dacd9bac6501d3df0344832e7f`, [auth routes](https://github.com/realchendahuang/FlareMo/blob/e42d98fb65a505dacd9bac6501d3df0344832e7f/apps/worker/src/routes/memos-current/auth-routes.ts), [context checks](https://github.com/realchendahuang/FlareMo/blob/e42d98fb65a505dacd9bac6501d3df0344832e7f/apps/worker/src/context.ts).

Test with synthetic HTTP responses: successful signin/me/logout, wrong credentials, malformed or expired credentials, changed identity, denied membership upstream, foreign origins, redirects, transport failure, session expiry and secret exclusion. These checks validate our adapter, not the live service. Live acceptance requires an allowed origin and a user-entered test account; record the deployed revision and results separately. Never publish participant details or credentials as Build in Public evidence.

## After login

Update (2026-09-21): the maintainer explicitly chose synthetic local accounts while FlareMo integration remains pending. `npm run community:demo` selects a separate mock provider with two hard-coded fictional identities and no external authentication requests. The UI labels every session synthetic and never asks for a password. It is not enabled as a fallback after live authentication failure. Real permissions and external identity bindings cannot be inherited by matching a mock display name. This extends the local experiment only; the product and data ownership plan is in the [architecture blueprint](../docs/COMMUNITY_BLUEPRINT.zh-CN.md).

1. Explicitly join a configured community and publish a small capability profile.
2. Verify control of one agent using a short-lived, single-use challenge; support disconnect/revocation. Describe this in RFC 0007 before implementing execution.
3. Publish selected capability offers and discover a second member. Self-description and proven work remain distinct.
4. Agree on one bounded request, obtain acceptance, and run it through a supported adapter.
5. Review one artifact with human/agent attribution; optionally publish selected material to FlareMo after separate sharing consent.

First product evidence: two consenting people and one agent complete a small, reviewed task. Login counts as an integration milestone, not evidence of collaboration or community traction.
