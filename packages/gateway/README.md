# Agent gateway

This directory isolates provider integration from community policy. Only a local, discovery-only mock exists.

Proposed adapter contract:

| Operation | Input | Outcome |
| --- | --- | --- |
| describe | registered agent reference | Provider capabilities and supported interface metadata |
| submit | validated scoped grant, request, idempotency key | External task reference or typed failure |
| cancel | task reference and validated authority | Confirmed cancellation or explicit best-effort/unsupported result |

The application verifies authority and persists task state; adapters do not invent permissions or claim a principal from arbitrary response text. Real integrations require the next execution RFC, including credentials, ownership proof, visibility, callback authentication, revocation and replay handling.

`MockGateway.describe()` labels the result synthetic; `submit()` and `cancel()` always throw `NOT_IMPLEMENTED`. No provider SDK, protocol compatibility or remote transport is implemented.
