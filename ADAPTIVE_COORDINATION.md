# Adaptive Coordination

## In simple words

Stensibly should preserve responsibility, authority, evidence, and continuation without turning every useful action into a fixed workflow. The ledger records the facts that must survive chats and processes. Workers remain free to adapt methods and scope when the work reveals a better path.

This agreement complements `AGENTS.md`, `STENSIBLY.md`, and the product model. It does not widen authority or replace safety boundaries.

## The coordination kernel

A meaningful work item should keep these facts legible:

- the outcome or bounded question;
- one current responsible actor;
- the next executable action;
- relevant issue, branch, revision, deployment, or artifact references;
- blockers, dependencies, and overlap fences;
- the current authority and approval boundary;
- the completion, recovery, transfer, or wake condition.

Store more structure when it improves correctness or continuation. Do not require fields or transitions merely because another project once used them.

## Responsibility is not a task script

A work item should express the result worth achieving and the important boundaries. It should not prescribe every command when the responsible worker can discover the best route.

A compact dispatch can begin with:

```text
Outcome or question:
Why it matters:
Useful starting points:
Known boundaries:
Responsible actor:
Next action:
```

The responsible actor may change implementation details, reorder safe steps, split independent findings, request specialist help, or propose a better outcome. Record a meaningful premise change, transfer, new dependency, or new consequential effect in the ledger.

## One responsible actor, flexible collaboration

Keep one current responsible actor for a coherent item so progress and handoff remain clear. That actor may delegate bounded parts or collaborate without surrendering responsibility for the item’s next state.

Responsibility may transfer. A callsign or GitHub identity provides attribution and provenance; it does not create authority, continuity, exclusive expertise, or a permanent employee-style role.

Do not force a useful continuation to impersonate the previous worker. Preserve the relationship to prior evidence and state the newly accepted responsibility.

## Separate responsibility from authority

Assignment, claim, callsign, role, or familiarity does not grant permission to perform an effect. The current authority grant and standing project policy remain decisive.

Adaptation is allowed inside the active authority boundary. When a newly discovered path would create a broader external, destructive, financial, privacy, access, or irreversible effect, stop at that boundary and record the decision or approval needed.

This is the distinction Stensibly exists to make visible: responsibility answers who must move the work; authority answers what that actor may currently do.

## Evidence lives beside the work

Use ledger events and item state for concise coordination facts. Keep detailed evidence in the system that owns it:

- source code and pull requests in GitHub;
- CI and deployment receipts in their execution systems;
- durable research or product reasoning in repository documents;
- logs, screenshots, comparisons, and generated results as referenced artifacts.

Stensibly should retain provenance and references rather than copy every external system into the ledger.

## Let work change shape

Exploration may become implementation. A bug may divide into separate safety, compatibility, and cleanup items. A planned change may become a negative result or an already-solved premise. A deployment may reveal the real product question.

When the shape changes:

1. retain the evidence already produced;
2. update the current outcome or split genuinely independent work;
3. record responsibility and overlap boundaries;
4. preserve the exact next action;
5. reassess authority and risk.

Do not keep an obsolete workflow alive merely to preserve its original labels.

## Review according to risk and uncertainty

Independent review is a tool, not a ritual.

- Mechanical and low-risk reversible work may use exact self-review.
- Bounded internal dogfood work may proceed under the standing policy after suitable checks and an explicit integration decision.
- Authentication, authorization, privacy, durable-state, schema, isolation, or uncertain-recovery work needs deliberate exact-candidate review and a credible recovery path.
- External or materially consequential effects require the approval defined by project policy.

Choose reviewers for relevant knowledge and their ability to challenge the actual evidence. Do not manufacture independence through fixed rings, alternate callsigns, or ceremonial reassignment.

## Keep process out of the product unless it is a real invariant

Stensibly may support claims, leases, handoffs, dependencies, approvals, runs, reservations, and events. It should not encode every local team habit as a universal product requirement.

Promote a coordination convention into a product invariant only when it protects correctness, authority fencing, recoverability, accountability, or a demonstrated user need. Keep adaptable conventions in repository guidance or workspace policy.

## External GitHub backlinks

Research coordination should not create accidental backlinks or notifications in third-party official repositories.

Apply backlink suppression to GitHub interaction text: issue and pull-request titles and bodies, comments, reviews, discussions, and intentional issue references in commit messages. In those surfaces, use:

```text
https://redirect.github.com/OWNER/REPOSITORY/issues/NUMBER
https://redirect.github.com/OWNER/REPOSITORY/pull/NUMBER
https://redirect.github.com/OWNER/REPOSITORY/discussions/NUMBER
https://redirect.github.com/OWNER/REPOSITORY/commit/SHA
```

Direct links among controlled `teamleaderleo/*` repositories are normal.

Repository documentation and other tracked files may link directly to third-party GitHub work because GitHub does not create autolinked issue or pull-request references in repository files. Those files do not need an automated reference check.

Repository homepages, documentation sites, specifications, package registries, release pages, and ordinary web sources may be linked normally.

Use direct third-party cross-references in interaction text only when an explicitly authorized upstream interaction is being performed or accurately recorded.

## Working rule

> Preserve responsibility, authority, evidence, continuation, and external safety. Adapt the rest to the work.

When instructions repeatedly create stalls, duplicate effort, unnecessary approval, misleading ownership, or lost evidence, improve the instructions and preserve the correction in version control.
