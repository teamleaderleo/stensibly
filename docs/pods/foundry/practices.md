# Foundry pod practices

Practices are versioned working conventions, not authority. They may be adopted,
trialled, rejected, or superseded with evidence.

## P-001 — Exact-head handoffs and acceptance

- **Status:** adopted
- **Practice:** Name the exact branch and revision in substantive handoffs and
  independent verdicts. A worker must not be the only acceptance signal for its
  own consequential implementation.
- **Evidence:** repeated OAuth and authority reviews exposed findings that green CI
  or earlier-head acceptance did not resolve.
- **Review condition:** revisit when the ledger can bind reviews to revisions
  directly.

## P-002 — One owner or explicit competition for overlapping implementation

- **Status:** adopted
- **Practice:** Prefer one implementation owner for overlapping files or state.
  Deliberate competition is allowed only when each candidate declares the overlap,
  provenance, integration plan, and independent selection requirement. Spare
  workers otherwise take review, reproduction, rollout preparation, research, or
  synthesis.
- **Evidence:** non-overlapping lanes reduce collision; explicit competing
  candidates can still recover dormant or blocked work without hiding provenance.
- **Review condition:** compare integration cost during the W01 retrospective.

## P-003 — Broad initial pod context

- **Status:** experimental, pending accepted PR #298 trial
- **Practice:** Offer Foundry as a broad context candidate during initial dogfood.
  Reading its files does not create participation. Propose a fork only with
  multi-run evidence and a reversible migration plan.
- **Baseline:** one proposed trial context, no active department taxonomy.
- **Evaluation:** context cost, duplicated reading, blocked acknowledgements,
  review independence, and recovery quality across waves.
- **Review condition:** after W01 or after three substantive runs reveal a recurring
  distinct context boundary.

## P-004 — No silent memory rewriting

- **Status:** adopted
- **Practice:** Append new knowledge or explicitly supersede an entry. Preserve
  provenance, confidence, scope, freshness, and the reason for the change.
- **Review condition:** replace with typed knowledge generations when #272 ships.

## P-005 — Reconcile after quiet or dormant time

- **Status:** experimental
- **Practice:** Do not infer expiry, notification, or fresh authority from silence
  or an open chat. After returning, read the current issue, PR, branch, tests,
  reviews, competing candidates, and authority records before acting. State what
  remains current and what is being continued, accepted, released, or compared.
- **Evidence:** issue #312 and the #301 multi-worker dogfood roster.
- **Review condition:** revisit after W01 and after typed worker lifecycle records.

## Rejected or retired practices

None yet. Record rejected experiments here with the tested context and reason so
future workers do not repeat them without new evidence.
