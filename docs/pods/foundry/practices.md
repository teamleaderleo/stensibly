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

## P-002 — One owner for overlapping implementation

- **Status:** adopted
- **Practice:** Use one implementation owner for overlapping files or state. Spare
  workers take review, reproduction, rollout preparation, research, or synthesis.
- **Evidence:** parallel non-overlapping lanes reduce branch collision and preserve
  independent review.
- **Review condition:** compare integration cost during the W01 retrospective.

## P-003 — Broad initial pod

- **Status:** experimental
- **Practice:** Keep Foundry broad during initial dogfood. Propose a fork only with
  multi-run evidence and a reversible migration plan.
- **Baseline:** one active pod serving the Stensibly project.
- **Evaluation:** context cost, duplicated reading, blocked acknowledgements,
  review independence, and recovery quality across waves.
- **Review condition:** after W01 or after three substantive runs reveal a recurring
  distinct context boundary.

## P-004 — No silent memory rewriting

- **Status:** adopted
- **Practice:** Append new knowledge or explicitly supersede an entry. Preserve
  provenance, confidence, scope, freshness, and the reason for the change.
- **Review condition:** replace with typed knowledge generations when #272 ships.

## Rejected or retired practices

None yet. Record rejected experiments here with the tested context and reason so
future workers do not repeat them without new evidence.
