# Infrastructure contracts

Current proposal version: **0.1.0**. These are draft contracts with executable local examples, not a deployed object service or a live A2A integration.

| Contract | Artifact | Implemented evidence |
| --- | --- | --- |
| Eight core objects | [JSON Schema](community/v0.1/object.schema.json), [glossary](../CONTEXT.md), [fixture graph](../examples/protocol/eight-objects.json) | Strict bundled schema subset and cross-object invariant checks |
| FlareMo persistence | [RFC 0005](../RFC/0005-core-objects-and-flaremo-store.md) | In-memory atomic writes, revisions, version history, command replay, event cursor; no real FlareMo writes |
| Community A2A profile | [version baseline](a2a/v0.1/profile.json), [RFC 0006](../RFC/0006-community-a2a-profile.md), [message example](../examples/protocol/a2a-send-message.json) | Example vocabulary and object references checked; no SDK or wire conformance test |

```sh
npm run objects:demo
npm test
```

The demo creates nine synthetic records covering all eight kinds, including two Humans. It does not authenticate participants, enforce production ACLs, run an agent, fetch artifact files or connect to an external instance.

The bundled schema checker supports only the keywords used by this schema. Its UTC timestamp profile requires millisecond precision. It is not a reusable general-purpose JSON Schema library. Consumers may validate the exported Draft 2020-12 schema with their own standards-compliant validator and must still implement authorization, lifecycle and relationship constraints from the RFC.

Unknown object/profile versions fail closed; incompatible changes create a new version and explicit migration. Stable object IDs survive storage and GitHub organization migrations. Real credentials are never part of fixtures or core object fields.
