# Vision

Status: founding thesis, revised 2026-09-22 by [RFC 0010](RFC/0010-opportunity-router.md). Open to refinement through evidence.

## The problem

A community knows who is here. It does not know who can get *this* done.

Communities are full of capability: people who know an industry, can design, can code, have run a sales channel, or know the right person. Opportunities arrive every day, too: a brand brief, a founder looking for a partner, a research question, a client project. Today the two meet by luck. Someone posts in a group chat, someone happens to see it, an organizer happens to remember the right member, and a thread of DMs may or may not become a collaboration.

The organizer is quietly acting as a human router. That works for 30 people, barely for 100, and fails at 500. A community does not have a people problem; it has a routing problem.

## The outcome

**Route every opportunity to the people — and their agents — who can make it happen, and learn from every collaboration.**

> People bring the judgment. Agents handle the coordination. The network learns from every collaboration.

A request comes in. The network works out what capabilities it needs and finds the members who have them. Their agents handle the first mile of coordination: availability, fit, constraints and missing inputs. Humans decide. A small team forms, the work gets done and reviewed, and the result becomes evidence of who can actually do what.

## Why now

Connecting agents to each other is becoming a commodity: projects such as OpenAgents, and protocols such as A2A and ANP, already let different agent runtimes discover and message each other. What remains unsolved is coordination around real demand: understanding a vague need, knowing who in *this* community can meet it, and having a human accountable for each decision. Agents make that coordination cheap enough to run continuously.

## Who it serves first

- Communities that already receive real opportunities (projects, briefs, bounties, research topics, client work) and whose members have diverse, under-used capabilities.
- Organizers who are currently the human router.
- Members, who self-serve: they post needs, keep their profile current, and suggest people for each other's requests. Their agents are optional helpers.

KOSX is the first validation community ([plan](docs/KOSX_VALIDATION_PLAN.zh-CN.md)). A second, unrelated community must get value from the same core before we claim the design generalises.

## Product commitments

1. **Requests are the fuel.** A network with members and agents but no real requests is dead. Feeding real opportunities in is the first job of every community that adopts it.
2. **Members self-serve; agents are optional.** Anyone can use the network without an agent. A member's agent may draft, suggest and answer on their behalf through a documented interface. It knows what it can do, what it should do and what it must not do.
3. **Humans decide.** Accepting a role, committing time or money, publishing a profile and accepting delivered work are always human decisions.
4. **Evidence over claims.** Accepted work, not self-description, is what the network learns from. Every accepted outcome updates who has proven which capability, and who has worked well together.
5. **Consent for profile data.** Profiles may be drafted from a member's own activity in the community (for example group chat) only after they sign the member agreement. Drafts stay private until the member confirms them; consent can be withdrawn.
6. **Community is a first-class node.** Its rules, membership and data belong to its operator. Private is the starting policy.
7. **Humans and agents have distinct identities.** Every agent has a human principal; records show both who acted and on whose behalf.
8. **Federation comes last.** Routing between communities matters only when one community cannot meet its own requests.
9. **Build in public, including failures.** Publish what did not work; protect participant data.

## The value flow

```text
Request → understand the need → match capabilities → community suggestions
        → pre-flight (availability, fit, constraints) → human accept → squad
        → artifacts → review → capability evidence + collaboration edges
        → better matches → more requests
```

## What we measure

Opportunities received, matched, squads formed, projects delivered, verified capabilities, suggestions made, invitation acceptance rate, and time from request to first accepted match. The number of registered agents is not a success measure.

## Not in the first slice

Social feed, direct messages, agent-to-agent social life, wallets, tokens, federation, marketplace ranking, global reputation scores and new protocols.

## Open questions

- Where does a steady flow of real requests come from, and who is responsible for it?
- How good do drafted profiles have to be before members confirm rather than rewrite them?
- Which incentives make members accept: paid work, equity, resource exchange, or reputation?
- What must a second community configure to get value without KOSX's data sources?
- Which coordination steps can agents take reliably before a human must step in?

These feed [RFCs](RFC/README.md) and the [roadmap](ROADMAP.md). Product claims advance only when evidence does.
