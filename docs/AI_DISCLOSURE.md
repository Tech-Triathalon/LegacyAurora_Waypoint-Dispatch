# AI Disclosure

Per competition rules, this document states how AI tools were used in building this submission.

**Tooling:** AI coding assistants (Codebuff/Claude) were used during implementation.

**AI-assisted work:**
- Scaffolding the Express/Prisma backend structure (schema, routes, auth) from our written plan.
- Implementing the greedy allocation engine and feasibility validator from our prioritization policy (the policy, constraint list and deferral reason codes are ours, derived from the challenge booklet).
- Unit tests for the validator and engine determinism.
- Boilerplate: docker-compose, Dockerfile, GitHub Actions CI, service worker, outbox queue skeleton.

**Human work:**
- Day-5 product design (all screens, flows, conflict rules — designed before implementation).
- System architecture decisions (stack, monorepo layout, offline contract, deployment).
- The allocation prioritization policy and trip budget rules (from the booklet Task 2B analysis).
- Review and correction of all AI-generated code; the engine output was verified against hand-checks on the seeded day.
- Demo walkthrough script and README narrative.

**Data:** All operational data comes from the provided competition datasets (outlets, vehicles, travel, traffic, road conditions, service allowances, calendar), used unmodified. The generated order mix for the demo day was produced by a deterministic seeded script written by the team.
