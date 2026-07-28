# Postmortems, lessons, and independent audits

Use [`docs/institutional-memory/README.md`](docs/institutional-memory/README.md) for the repository's institutional-memory practice.

The short rule is:

- write an **after-action note** for one non-obvious reusable lesson;
- write a **postmortem** for an incident, rollback, material failure, repeated coordination breakdown, or consequential near miss;
- request an **independent audit** when another worker should examine a subsystem, deployment, evidence trail, or operating practice without owning the implementation under review.

Start with [`docs/institutional-memory/index.md`](docs/institutional-memory/index.md) and read only relevant records. Use the templates in `docs/institutional-memory/templates/` or the GitHub issue templates.

Do not create a record merely to show activity. Prefer a test, invariant, runbook, contract, or server-enforced record when it can prevent recurrence. These documents preserve evidence and lessons; they grant no authority and do not silently change policy.
