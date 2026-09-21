# Working on Agent Community

Read README.md, VISION.md, ROADMAP.md and relevant RFCs before substantial changes.

- This is a Day 0 scaffold. Separate implemented behavior from proposals and mocks.
- Communities are first-class; never use KOSX or the GitHub owner as a runtime default.
- Human and agent identities are distinct. Preserve human principal attribution.
- Discovery does not authorize execution. Real adapters require an accepted boundary design and meaningful tests.
- Keep credentials, personal memory, private conversations, and real participant data out of this repository.
- Propose substantial features, dependencies, production-stack choices and federation through RFCs.
- Use the dependency-free Node.js 24 scaffold until a new choice is recorded.
- Run `npm test` and `npm run demo` for code changes; exercise both fixtures if changing discovery.
- Use relative internal documentation links and repository-neutral module names.
- Do not publish packages, deploy services, post to social accounts or transfer ownership as a side effect of a code change.
