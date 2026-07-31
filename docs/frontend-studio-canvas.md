# Studio Canvas frontend prototype

**Owner issue:** #612  
**Parent programme:** #605  
**Route:** `/labs/studio-canvas/`

## Thesis

Studio Canvas tests whether Stensibly works better when the selected deliverable becomes the visual center of gravity.

The common shell keeps work navigation on the left, the artifact in the center, and evidence/comments/versions/activity in a contextual inspector. Ordinary inspection does not open a modal. The command dialog is reserved for switching work, inspector tabs, available comparison, and recoverable desktop layout.

## Shared task translation

Five fictional artifacts preserve the shared evaluation tasks:

- `approve-release-note` — proposed decision document and the only human approval;
- `worker-health` — attached brief naming healthy Moss and unhealthy Ember;
- `repair-focus-order` — local implementation plan and top recommendation;
- `deploy-amber` — stale operation receipt with ambiguous settlement;
- `connection-health` — accepted capability note for GitHub, API, and MCP.

Each artifact writes source, revision, freshness, authority, persistence, owner, evidence, and one safe next action.

`../fixtures.classic.js` and `fixture-policy.js` load before `app.js`. The policy admits the exact five-artifact order and projects shared decision, worker, ready-work, operation, and provider truth before the first render. The app uses that one frozen artifact set for work navigation, the artifact sheet, inspector, commands, local explanations, and announcements. `workspace-bridge.js` is limited to dynamic heading identity, roving-tab semantics, and replacement focus. Local revision labels, comments, comparison examples, evidence filenames, activity times, authority copy, persistence copy, and artifact presentation states remain route-specific metadata.

## Artifact state honesty

The shell distinguishes states with a symbol and literal text:

- `✎ local` — exists only in this page instance;
- `◆ proposed` — awaiting a real decision; not approved or saved;
- `＋ attached` — fixture evidence is associated with the artifact;
- `✓ accepted` — the fictional revision is the accepted comparison reference;
- `! stale` — freshness or settlement is insufficient for action.

“Accepted” describes fixture history. It does not grant live product authority. The masthead always says `review mode`, `fixture only`, and `nothing saved`.

## Version and comparison boundary

The Versions inspector exposes current, earlier accepted, and stale fictional revisions when they exist. Comparison renders earlier and current text together.

- comparison does not restore, branch, approve, save, publish, or mutate anything;
- comparison is omitted from command search when the selected artifact has no earlier revision;
- the toggle also fails closed with `No earlier revision is available for comparison` if invoked after availability changes;
- the recovery control only explains that a real restore or branch needs explicit reviewed action;
- the ambiguous publication receipt exposes no retry control;
- the release-note proposal exposes no approval control in the prototype.

## Visible local explanations

`Open source summary` and `Explain next action` render a visible, focusable result directly above the artifact sheet and repeat the same copy through the live announcer. The source result writes the admitted source and local revision. The next-action result writes the exact shared or route-specific safe action and states that no save, approval, submission, or write occurred.

Changing artifacts clears the prior result so one artifact never inherits another artifact’s explanation.

## Command and focus contract

Command/Ctrl-K or `/` opens command search. The return target is admitted only when connected, visible, focusable, and outside the dialog; keyboard opening from `body` falls back to the command trigger.

Every available command has an explicit destination:

- artifact commands focus the replacement selected work row;
- inspector commands focus the replacement selected tab;
- available comparison focuses the artifact sheet;
- desktop collapse commands focus their visible recovery controls.

Destination commands suppress ordinary dialog-return focus before closing, so an inspector control that is removed by the command never becomes the terminal focus target. Escape and ordinary dismissal retain validated return focus.

## Responsive collapse contract

Desktop work and inspector regions can collapse and have fixed recovery controls. At widths up to 48rem, all regions stack in document order, collapse controls disappear, stale collapsed datasets are cleared, and collapse commands are omitted from search. The collapse function also rejects a narrow-layout collapse request, so a stale command cannot focus a hidden recovery control. Crossing into the narrow contract restores both regions before the responsive CSS forces stacked visibility.

## Common workspace primitives

Reusable across artifact types:

- edge work navigation with persistent selection;
- artifact identity, revision, mode, authority, freshness, and persistence;
- central readable sheet;
- evidence, comments, versions, and activity tabs;
- local revision comparison when an earlier revision exists;
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

The prototype does not pretend that every artifact supports selected-text actions, code execution, image editing, diagram editing, direct persistence, or revision comparison. Those require artifact-specific models and reviewed authority.

## Keyboard and layout

- Command/Ctrl-K or `/` opens command search.
- J/K and Arrow Up/Down move selected work.
- Keys 1–3 focus work, artifact, and inspector.
- `[` and `]` move inspector tabs.
- Arrow Left/Right, Home, and End operate the inspector’s roving tab contract.
- Escape closes the command dialog and restores a validated origin.
- Desktop work and inspector regions can collapse; fixed text controls restore them.
- At narrow width, all regions stack in document order and collapse controls are disabled so no region becomes unrecoverable.

## Comments and local editing

The comment textarea is a local preview input. Its nearby copy states that nothing is saved, attached, submitted, or approved. The only action explains that local-only state. It performs no persistence.

The center artifact is inspectable, not directly editable. A future editor would need explicit dirty state, save target, conflict handling, authority, recovery, and durable revision receipts.

## Deliberately rejected patterns

- implying autosave, approval, or persistence without a receipt;
- offering comparison without an earlier revision;
- modal hopping for evidence, versions, and activity;
- permanent icon-only toolbars;
- hiding source, authority, freshness, or state;
- unrecoverable collapsed panels or hidden recovery focus;
- one generic editor pretending all artifact types have identical actions;
- framework migration solely for the prototype;
- gradients, remote fonts, copied product imagery, analytics, trackers, or network data.

## Fixture and authority boundary

The route is a zero-build classic-script prototype using locally authored HTML, CSS, JavaScript, and the merged shared fictional Paper Lantern fixture. It contains no remote asset, library, iframe, API request, credential, storage state, private record, analytics, live approval, save, branch, restore, retry, or publication action.

## Recovery

Revert the eventual Studio Canvas squash commit to restore the planned placeholder and manifest entry. No production dashboard, authentication, API, persistence, deployment, or durable state is involved.

— Cinder  
Intention: test whether the deliverable is a better center of gravity than the task card without lying about persistence or authority.
