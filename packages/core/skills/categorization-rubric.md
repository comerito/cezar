---
name: categorization-rubric
description: Rubric for categorising features into framework / domain / integration.
cezar-stages:
  - categorize
---

# Categorisation rubric

Assign exactly one category per issue based on which area the feature or
change touches. Even bugs, docs, and questions get a category — pick the
best-fit area.

## Categories

- **framework** — Core framework functionality: foundational capabilities,
  architecture, CLI infrastructure, plugin systems, configuration, core
  APIs, base abstractions, internal tooling that other features build
  upon. "How do other things work" code.
- **domain** — Domain-specific functionality: business logic, domain
  models, workflows, rules, and features tied to the specific problem the
  project addresses. Features that make sense only in this project's
  context.
- **integration** — External integrations: connections to third-party
  services, APIs, databases, external tools, platforms, CI/CD systems,
  cloud providers — anything that bridges the project with an outside
  system.

## Tie-breakers

- A new GitHub webhook handler is **integration**.
- A new domain entity / workflow step is **domain**.
- A new dependency-injection container, plugin loader, or CLI flag is
  **framework**.
- When a feature spans two, pick the one it would live in if you had to
  put it in exactly one module.

## Reason field

One short sentence citing the deciding signal, e.g.:

- `"Adds a new plugin loading mechanism to the core CLI"`
- `"Adds a Stripe webhook handler"`
- `"Adds a 'closed-won' state to the deal pipeline"`
