# Commander read: bounded first slice

Owner: [#1698 commander discussion](https://github.com/teamleaderleo/stensibly/issues/1698#issuecomment-5485609716).

`get_brief` compiles the existing project snapshot into one commander view. Open
decisions/questions, blockers, and expired or unverified claims come first; ready
tasks carry their recorded next action and priority as an inspectable selection
reason. With at least two slots, one is reserved for a ready candidate; with at
least three, one is also reserved for a recorded task result. This keeps old
blockers from hiding every opportunity and result. Up to two results may appear. Rows
appear once. Active work with live claims and historical knowledge stay compact.

Each row's `id` expands through `get_runner_context({id})`. The result also names
the project policy and omitted-work reads. A ready record is a candidate to inspect,
not evidence that provider capacity, dependencies or execution admission passed.

Pass the returned `fingerprint` as `previousFingerprint` on a later planning read.
Authorization and the ledger query run again before comparison. Snapshot age,
claim expiry, scope, full selected text (including truncated suffixes), artifact
evidence, and omitted coverage participate in the decision. Old snapshots and
incomplete attention scans cannot return unchanged. Output omissions from a complete
scan can return unchanged: every evaluated actionable/result row binds the digest,
and omission counts and expansion references remain in the response. Unevaluated hosted runs or
reservations also prevent unchanged in this first slice. A matching fingerprint
never authorizes an effect.

The public renderer shows record timestamps, bounded reasons, summaries, next actions and exact row
references instead of replacing a large brief's text with only a hash. Text and
structured content derive from the same object.

## Same-input measurement

The initial-slice measurements below are historical. The connected follow-up on
2026-09-05 found a 47-record project whose limit-3 read showed only three old
blockers, hiding five ready items and all 32 done records. A second `list_work`
read was needed to name a candidate. The balanced selection now exposes a blocker,
candidate and result in that one overview, while clearly dating the stored evidence.

A matching synthetic backlog compared against the pre-change compiler returns
2,715 bytes initially versus 2,623 before; the 92-byte increase buys record dates
and broader decision coverage. Repeated unchanged output falls from 2,623 to
1,182 bytes (55% smaller), including omission counts and exact expansion references.
Tests verify that hidden blocker edits and clearing invalidate the fingerprint.

Run `bun scripts/measure-commander-read.ts`. It uses the retained original ledger
brief and generic renderer for the baseline, then sends the identical source facts
through the current public MCP operation. It writes full before/after examples and
wire-result byte counts to `artifacts/commander/comparison.json`.

Measured 2026-09-05; bytes include both text and structured content:

| Situation | Before | After | Unchanged repeat |
| --- | ---: | ---: | ---: |
| Useful overview | 3,795 | 2,280 | 703 |
| Completed result | 3,792 | 2,277 | 703 |
| Blocker appears | 3,756 | 2,148 | 703 |
| Blocker clears | 3,820 | 2,330 | 703 |

The first justified planning decision takes **one read before and after** in these
fixtures. This slice proves 39–43% lower initial bytes and about 81% lower repeat
bytes; it does not claim a measured reduction in tool-call count. Exact execution
still needs the named current-context/admission read. No second broad read is
needed to discover the expansion operation or its argument.

For the blocker fixture, the old structured result contains five full healthy
worker rows and duplicates the decision and historical finding. Its text is only
`{"structured":true,"sha256":"…"}`. The new text names the open acceptance-target
decision and says:

```text
blocked: Verify the delivered result — Acceptance target unavailable.
Next: Restore the target or choose another.
[get_runner_context id=<exact fixture item id>]
```

After clearing, that task appears once as a ready candidate with the recorded
recovery summary and next action. After completion it appears as recorded done,
with its last update time in structured content. A repeat says:

```text
Unchanged commander view. Provider availability and execution admission remain unverified.
```

## Limits and continuation

This is a current ledger snapshot replacement, not an event-history delta.
`updatedAt` is a record timestamp, not proof of the time of completion. Historical
knowledge, provider state, run failure/recovery evidence and capacity must not be
inferred from the absence of a row. Coverage and omission fields preserve those
limits. Hosted run/reservation observations remain explicitly unevaluated and
prevent unchanged until their owning current-evidence adapter is integrated.

The compiler scans at most 100 rows per existing source section and uses one
shared output row budget (`limit`, default 10). Incomplete actionable scans are
explicit. Text clipping is marked and full evaluated semantics bind the digest.
No new tool, storage ledger, Convex schema, execution path or history owner is added.

The optional input and routing description rotate the published action contract;
the existing release receipt and refresh process remain owned by
[chatgpt-app-recovery.md](chatgpt-app-recovery.md). Local preflight proves the
candidate contract, not portal publication or a fresh connected ChatGPT read.

The existing guarded Worker release script also runs `verify-commander-read.ts`
against both production origins using its protected read credential. It binds the
exact deployed Worker version, reads the brief, repeats with its fingerprint, and
expands one returned item when present. Logs retain only byte counts, status,
fingerprint, request ID and deployment identity; work prose and credentials remain
inside the protected execution surface. Readback failure uses the release guard's
existing baseline restoration and recovery verification.
