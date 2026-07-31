# Studio Canvas frontend prototype

**Owner issue:** #612  
**Parent programme:** #605  
**Route:** `/labs/studio-canvas/`

## Thesis

Studio Canvas tests whether Stensibly works better when the selected deliverable becomes the visual center of gravity.

The common shell keeps work navigation on the left, the artifact in the center, and evidence/comments/versions/activity in a contextual inspector. Ordinary inspection does not open a modal. The command dialog is reserved for switching work, inspector tabs, comparison, and layout.

## Shared task translation

Five fictional artifacts preserve the shared evaluation tasks:

- `approve-release-note` — proposed decision document and the only human approval;
- `worker-health` — attached brief naming healthy Moss and unhealthy Ember;
- `repair-focus-order` — local implementation plan and top recommendation;
- `deploy-amber` — stale operation receipt with ambiguous settlement;
- `connection-health` — accepted capability note for GitHub, API, and MCP.

Each artifact writes source, revision, freshness, authority, persistence, owner, evidence, and one safe next action.

## Artifact state honesty

The shell distinguishes states with a symbol and literal text:

- `✎ local` — exists only in this page instance;
- `◆ proposed` — awaiting a real decision; not approved or saved;
- `＋ attached` — fixture evidence is associated with the artifact;
- `✓ accepted` — the fictional revision is the accepted comparison reference;
- `! stale` — freshness or settlement is insufficient for action.

“Accepted” describes fixture history. It does not grant live product authority. The masthead always says `review mode`, `fixture only`, and `nothing saved`.

## Version and comparison boundary

The Versions inspector exposes current, earlier accepted, and stale fictional revisions. Comparison renders earlier and current text together.

- comparison does not restore, branch, approve, save, publish, or mutate anything;
- the recovery control only explains that a real restore or branch needs explicit reviewed action;
- the ambiguous publication receipt exposes no retry control;
- the release-note proposal exposes no approval control in the prototype.

## Common workspace primitives

Reusable across artifact types:

- edge work navigation with persistent selection;
- artifact identity, revision, mode, authority, freshness, and persistence;
- central readable sheet;
- evidence, comments, versions, and activity tabs;
- local revision comparison;
- explicit next action;
- command/search surface;
- recoverable work and inspector collapse;
- desktop three-region and narrow stacked layouts;
- keyboard movement and region focus.

## Artifact-specific behavior

- **decision document:** prose and explicit decision request;
- **worker brief:** named worker and lease observations;
- **implementation plan:** rationale, acceptance, and non-goal;
- **operation receipt:** observed, unknown, and safe reconciliation sections;
- **capability note:** provider-by-provider availability.

The prototype does not pretend that every artifact supports selected-text actions, code execution, image editing, diagram editing, or direct persistence. Those require artifact-specific models and reviewed authority.

## Keyboard and layout

- Command/Ctrl-K or `/` opens command search.
- J/K and Arrow Up/Down move selected work.
- Keys 1–3 focus work, artifact, and inspector.
- `[` and `]` move inspector tabs.
- Escape closes the command dialog and restores its origin.
- Desktop work and inspector regions can collapse; fixed text controls restore them.
- At narrow width, all regions stack in document order and collapse controls are disabled so no region becomes unrecoverable.

## Comments and local editing

The comment textarea is a local preview input. Its nearby copy states that nothing is saved, attached, submitted, or approved. The only action explains that local-only state. It performs no persistence.

The center artifact is inspectable, not directly editable. A future editor would need explicit dirty state, save target, conflict handling, authority, recovery, and durable revision receipts.

## Deliberately rejected patterns

- implying autosave, approval, or persistence without a receipt;
- modal hopping for evidence, versions, and activity;
- permanent icon-only toolbars;
- hiding source, authority, freshness, or state;
- unrecoverable collapsed panels;
- one generic editor pretending all artifact types have identical actions;
- framework migration solely for the prototype;
- gradients, remote fonts, copied product imagery, analytics, trackers, or network data.

## Fixture and authority boundary

The route is a zero-build classic-script prototype using locally authored HTML, CSS, JavaScript, and fictional Paper Lantern artifacts. It contains no remote asset, library, iframe, API request, credential, storage state, private record, analytics, live approval, save, branch, restore, retry, or publication action.

It temporarily duplicates the shared fictional identities so it remains independently interactive in the catalogue's opaque `sandbox="allow-scripts"` frame. A later reviewed change may consume the shared classic fixture bridge once that bridge is merged and stable.

## Recovery

Revert the eventual Studio Canvas squash commit to restore the planned placeholder and manifest entry. No production dashboard, authentication, API, persistence, deployment, or durable state is involved.

— Cinder  
Intention: test whether the deliverable is a better center of gravity than the task card without lying about persistence or authority.
