# Decision: Keep synthetic credential fixtures scanner-safe

- **Status:** experimenting
- **Date:** 2026-08-10
- **Owning issue:** #1332
- **Implementation:** PR #1330 fixture repair at `4340d5fc31e2f2d8cdcdf342b593a840ab54018f`; repository guidance follow-up tracked by #1332
- **Supersedes:** none
- **Superseded by:** none

## In simple words / purpose

Security tests still need realistic credential-shaped runtime inputs. Committed source should avoid complete synthetic credentials that secret scanners can reasonably classify as live secrets, so scanner alerts retain useful signal.

## Context and evidence

PR #1330 added a test proving that project-attachment setup rejects credential-shaped repository checks. GitGuardian then reported the synthetic Bearer-style test fixture as a hardcoded Bearer Token. The flagged text was test data, and the runtime security behavior being exercised was correct.

The standing project policy already keeps protected secret values inside protected execution surfaces and out of logs, comments, chat, tests, and retained artifacts. The missing convention concerns fabricated values: a worker can avoid real secret exposure while still spelling a complete fake credential in a form that lexical secret scanners detect.

PR #1330 was repaired without changing its runtime case. The test now assembles the Bearer-style input from fragments and generated characters, preserving the credential-shaped value seen by the validator while removing the complete detector-shaped literal from committed source.

## Decision

Treat synthetic credentials as scanner-sensitive source text whenever their committed representation resembles a real credential.

For tests, fixtures, docs, comments, snapshots, and examples:

- avoid committing complete detector-valid synthetic credentials;
- when a test requires a complete credential-shaped runtime value, assemble it from fragments or generated characters at runtime;
- use visibly invalid placeholders such as `<REDACTED_TOKEN>` or `[credential]` when the complete runtime form adds no test value;
- preserve the actual rejection, redaction, parsing, or authorization behavior under test;
- repair the fixture representation before weakening a validator or secret-scanning rule.

This decision changes presentation of synthetic values. It leaves credential formats, validators, authorization policy, protected-secret handling, and scanner coverage unchanged.

## Rationale

Secret scanners intentionally judge text by recognizable credential forms and context. They cannot reliably infer that a plausible token literal is harmless because a nearby test name says it is fake.

Keeping detector-shaped fixtures out of committed text gives future alerts stronger meaning while retaining adversarial coverage at runtime. Runtime construction also makes the intent explicit: the test needs a credential-shaped value, while the repository does not need to store one verbatim.

## Alternatives considered

### Alternative: Ignore synthetic findings in GitGuardian

- Why it was plausible: the reported value can be reviewed and marked harmless after each alert.
- Why it was declined: repeated synthetic findings add review noise and train contributors to dismiss secret alerts.
- Evidence that could justify revisiting it: a specific detector produces unavoidable findings even when runtime construction and invalid placeholders are used.

### Alternative: Disable or broadly exclude tests from secret scanning

- Why it was plausible: adversarial tests often contain hostile or credential-like inputs.
- Why it was declined: tests are also a realistic place for an actual credential to be pasted accidentally, so broad exclusion removes useful coverage.
- Evidence that could justify revisiting it: a narrowly scoped scanner configuration can exclude a generated artifact with no plausible real-secret content while preserving test-source coverage.

### Alternative: Make credential-rejection tests less realistic

- Why it was plausible: obviously invalid placeholders are scanner-safe.
- Why it was declined: some validators need realistic prefixes, lengths, separators, or header forms to prove their behavior.
- Evidence that could justify revisiting it: the complete credential form contributes no behavior beyond a simpler invalid placeholder.

## Consequences

### Benefits

- GitGuardian findings have higher signal.
- Adversarial credential coverage remains realistic at runtime.
- Workers get a repeatable presentation rule for tests, docs, comments, and fixtures.
- A scanner alert against a complete committed credential becomes more exceptional and easier to investigate promptly.

### Costs and accepted imperfections

- Some test fixtures become a few lines longer because values are assembled from fragments.
- A determined scanner may still flag some generated or fragmented representations; those cases require detector-specific review.
- Existing historical commits can continue containing old synthetic literals even after current branches are repaired.

### Risks and mitigations

- **Risk:** workers weaken security tests to avoid scanner noise. **Mitigation:** preserve the exact runtime credential shape when that shape is relevant.
- **Risk:** workers treat fragmentation as a way to conceal a real credential. **Mitigation:** protected secret values remain prohibited in retained artifacts regardless of representation; this convention applies only to fabricated values.
- **Risk:** broad scanner ignores hide genuine leaks. **Mitigation:** prefer source-presentation repair and keep scanner coverage enabled.

## Validation

- **Evidence already available:** GitGuardian flagged the synthetic Bearer-style fixture on #1330; commit `4340d5fc31e2f2d8cdcdf342b593a840ab54018f` preserves the runtime test while removing the complete literal.
- **Acceptance signal:** credential-focused tests retain their coverage and new pull requests stop producing findings solely from complete synthetic credential literals.
- **Failure signal:** the convention causes lost security coverage, recurring unavoidable scanner findings, or contributors begin using fragmentation around real secret values.
- **Review or experiment period:** evaluate through subsequent credential, authentication, provider, and redaction changes; record concrete exceptions on #1332.

## Recovery and supersession

If runtime construction proves insufficient or cumbersome, replace this convention with a narrower helper or scanner-specific fixture strategy while preserving scanner coverage and realistic security tests. A replacement decision should link #1332 and this record in both directions.

## History

- 2026-08-10 — experimenting: operator asked for a durable correction after reviewing the repeated GitGuardian presentation problem; #1332 opened and #1330 received the first scanner-safe fixture repair.

— Lark · scanner-safe fixture lane
  Intention: keep adversarial credential coverage while preserving high-signal secret scanning.
