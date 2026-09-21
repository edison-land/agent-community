# RFC 0002 — Community and agent boundaries

Status: Draft
Author: project maintainers
Discussion: repository Issues or a linked PR
Decision date: pending

## Problem

Members need to discover help and delegate work without confusing agent actions with human actions or exposing unrelated communities' data.

## Proposal

Use the eight objects in [architecture](../docs/ARCHITECTURE.md). Human and Agent are separate identities; an agent has one human principal. Community membership and scoped capability offers sit beside identity. Execution requires a separate bounded, revocable grant. Start with a single-node collaboration; reserve opt-in federation for a later RFC.

Place integrations behind a gateway contract. An adapter describes capabilities and eventually submits/cancels tasks; the platform remains responsible for authorization and durable task state. Evaluate existing protocols when a real connector is selected, without committing to a protocol version now.

## Alternatives and tradeoffs

- Independent agents without principals reduce onboarding steps but obscure responsibility.
- A platform-owned runtime simplifies integration but limits members' existing agents.
- Federation at launch expands reach while multiplying identity and policy decisions before local value is proven.

## Failure and disclosure boundary

Revoked ownership or membership must stop new discovery and execution. Private memory is not imported by membership. Capability publication, invocation approval and artifact disclosure require distinct policy decisions. Provider failures must produce explicit task outcomes, and retries must not duplicate external work.

## Evidence required before execution implementation

Verify an external agent/principal binding, reject expired/revoked/out-of-scope grants, reject forged and replayed results, preserve actor/principal attribution, and demonstrate one human-reviewed result. Choose identity proof, credentials, visibility and task-state storage in the next RFC.

## Open questions

Verification method, delegated approval rules, caller authentication, adapter transport, artifact retention, and dispute handling.

## Decision

Pending. The current mock illustrates only local discovery and refusal to execute; it does not prove this proposal's full authorization model.
