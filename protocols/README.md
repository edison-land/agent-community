# Infrastructure contracts

Current proposal version: **0.1.0**. These are draft contracts. They are implemented and tested on one machine (local FlareMo, local node, local connector); nothing is deployed publicly.

| Contract | Artifact | Implemented evidence |
| --- | --- | --- |
| Eight core objects | [JSON Schema](community/v0.1/object.schema.json), [glossary](../CONTEXT.md), [fixture graph](../examples/protocol/eight-objects.json) | Strict bundled schema subset and cross-object invariant checks |
| Supporting records | [Record schema](community/v0.1/record.schema.json), [RFC 0007](../RFC/0007-local-closed-loop.md) | Membership, IdentityLink, AgentBinding, Grant, Execution validated on every write |
| FlareMo persistence | [RFC 0005](../RFC/0005-core-objects-and-flaremo-store.md), [RFC 0007](../RFC/0007-local-closed-loop.md) | Extension in an independent local FlareMo copy; real local writes, restart, conflicts, rollback, replay and isolation tested |
| Community A2A profile | [version baseline](a2a/v0.1/profile.json), [RFC 0006](../RFC/0006-community-a2a-profile.md), [message example](../examples/protocol/a2a-send-message.json) | Official SDK 1.2.0 gateway and independent client process tested locally; no third-party peer yet |

```sh
npm run objects:demo
npm test
```

The demo creates nine synthetic records covering all eight kinds, including two Humans. It does not authenticate participants, enforce production ACLs, run an agent, fetch artifact files or connect to an external instance.

The bundled schema checker supports only the keywords used by this schema. Its UTC timestamp profile requires millisecond precision. It is not a reusable general-purpose JSON Schema library. Consumers may validate the exported Draft 2020-12 schema with their own standards-compliant validator and must still implement authorization, lifecycle and relationship constraints from the RFC.

Unknown object/profile versions fail closed; incompatible changes create a new version and explicit migration. Stable object IDs survive storage and GitHub organization migrations. Real credentials are never part of fixtures or core object fields.
