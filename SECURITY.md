# Security policy

This repository is a local offline scaffold. There is no supported production deployment or security-reviewed agent execution path. Security fixes target `main`; no release support schedule exists yet.

Report suspected vulnerabilities privately through the repository's **Security → Advisories → Report a vulnerability** flow when available. Include the affected revision, reproduction steps, expected impact, and a minimal synthetic example. Do not include real credentials or private participant data.

If private reporting is unavailable, open an Issue that only asks maintainers to enable it; keep exploit details private until a channel is established. Maintainers will acknowledge and coordinate remediation when available; no response-time guarantee is made at this stage.

Before real integrations, the project requires authenticated callers, membership/visibility enforcement, bounded revocable grants, endpoint restrictions, credential isolation, replay protection and durable task audit. See the [architecture proposal](docs/ARCHITECTURE.md).
