# Repository transfer

Initial owner: `edison-land`. Possible future destination: `ai-kosx`.

Transfer is a future administrative decision. The scaffold performs no transfer and contains no scheduled transfer automation.

## Keep the code portable

- Use relative documentation links and owner-neutral module identifiers.
- Keep editable repository branding/ownership in `project.json`; do not load it into the domain model.
- Community IDs, agent IDs and policy are independent of GitHub names.
- Keep community examples replaceable. KOSX is not a mandatory seed tenant.
- Package publishing is disabled (`private: true`). No registry, domain or deployment is configured.
- CI uses the current checkout and no organization-specific secrets or branch conditions.

## Checklist for a later authorized transfer

1. Confirm repository admin access, permission to create repositories in `ai-kosx`, and absence of a same-name repository or conflicting fork at the destination.
2. Agree receiving maintainers and governance. Review organization defaults and access policy.
3. Inventory integrations, Actions permissions/secrets, webhooks, Pages, domains, packages and branch rules; reassess anything added after Day 0.
4. Transfer the existing repository through GitHub settings so its history and collaboration remain attached.
5. Update `project.json` current owner, README clone examples and governance contact references. Preserve initial-owner history.
6. Update local `origin`, verify Issues/PRs/security reporting, and run CI from the new owner.
7. Update any package or hosting references separately. Do not recreate the old repository path, which can remove redirects.

GitHub documents that history and repository collaboration move with a transfer; Pages and packages need separate attention. Recheck the current [GitHub transfer documentation](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository) when executing it.
