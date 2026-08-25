# Current work entry point

This path is retained as a compatibility pointer for older bootstraps, accepted instruction records, and historical links. It **does not own live project state**.

Current executable work is derived from its canonical owners:

- repository policy: [`AGENTS.md`](../AGENTS.md) and [`STENSIBLY.md`](../STENSIBLY.md);
- durable product direction: the owning GitHub issue/programme;
- current issues, pull requests, reviews, checks, branches, and deployments: GitHub;
- responsibility, authority, commands, receipts, decisions, continuations, and recovery: Stensibly;
- provider-specific current state: the owning provider/read surface.

A fresh worker should inspect those sources at decision time and select one useful current responsibility or bounded unclaimed issue. Do not copy exact heads, worker rosters, queue order, recent merges, CI state, deployment state, or temporary blockers into this file.

Historical runs may legitimately record an older revision of `docs/current-wave.md` as an accepted instruction source. That proves what the run consumed; it does not make the historical contents current.

If workers later need a compact “what can I do now?” answer, compile it on demand from current work/dependency/authority/provider records and return source identities with the result. A generated projection may be cached by fingerprint; this Markdown file should never become that cache.

## Process deletion rule

```text
new coordination failure
-> smallest temporary instruction/procedure
-> repeated evidence
-> deterministic check / typed state / generated projection / safer default
-> delete the procedure
```

— Kestrel
  Intention: preserve the compatibility path while live state comes from live owners
