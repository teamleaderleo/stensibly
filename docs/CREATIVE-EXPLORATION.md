# Creative exploration

Use this optional workflow when a consequential human-facing decision has several credible answers and the preferred direction is still unclear. It is meant for occasional use around interface design, information presentation, product language, documentation, and other work where judgment and taste carry much of the value.

The workflow has two stages:

1. **Diverge:** produce a few intentionally different candidates against the same brief.
2. **Converge:** make a human decision, choose one branch, and continue iterating there.

Parallel candidates are most useful for discovering a direction. A continuing implementation thread is most useful once the direction is known.

## First question: direction or execution?

Ask what kind of uncertainty exists.

- **Direction uncertainty:** several substantially different answers could satisfy the requirements. Explore alternatives.
- **Execution uncertainty:** the intended result is already clear, while the current attempt needs refinement. Stay on one branch and iterate.

Examples of direction uncertainty include choosing a navigation model, deciding how dense a board should feel, finding the right product voice, or comparing several ways to explain the same system state.

Examples of execution uncertainty include spacing cleanup, responsive repairs, accessibility corrections, clearer error handling, or tightening copy after its angle has been chosen.

## Use selectively

This process is a good fit when:

- the decision is visible or repeatedly encountered;
- several valid treatments are plausible;
- seeing alternatives would change the decision;
- the candidate cost is modest enough to discard work;
- the result depends on human preference alongside functional requirements.

A single implementation is usually sufficient when:

- the direction is already settled;
- acceptance criteria determine most of the answer;
- the work is routine maintenance or repair;
- candidate implementations would be expensive and differ only cosmetically;
- the remaining questions can be expressed as specific edits.

## 1. Define the decision

Separate fixed requirements from open decisions before generating candidates.

### Fixed

Record behavior and constraints that every candidate must preserve:

- user task and primary outcome;
- data and domain rules;
- accessibility and responsive requirements;
- security, privacy, and permission boundaries;
- compatibility and performance requirements;
- established product principles that already have an explicit decision behind them.

### Open

List the questions the exploration should answer. Examples:

- How should hierarchy be communicated?
- Which information belongs on the main surface?
- How much visual character is appropriate?
- Which controls should remain continuously visible?
- What should happen on narrow screens?
- Which product promise should the copy emphasize?

An exploration without explicit open questions tends to produce loosely related redesigns that are difficult to compare.

## 2. Gather a small reference set

Use a few relevant examples from shipped products, existing repository decisions, screenshots, or prior experiments. For every reference, record the specific quality worth examining.

Also record anti-references: patterns that may look polished while conflicting with this product. Examples include generic dashboard cards, decorative gradients, excessive disclosure, low-density layouts, or copy that could belong to any software product.

References provide a vocabulary. Candidates still need to solve the problem in this repository.

## 3. Choose the amount of divergence

Use the cheapest level that can answer the open question.

- **Small variation:** one overall direction with alternatives for placement, density, copy, or control behavior.
- **Directional variation:** candidates follow different priorities, such as continuity, reduction, utility, editorial character, or playfulness.
- **Conceptual variation:** candidates use different interaction models or information arrangements.

Broad conceptual exploration belongs early. Later work usually benefits from smaller variations around an accepted direction.

## 4. Assign distinct candidates

Three candidates are a useful default. Give each one a reason to exist rather than asking several agents to “make it better.” A common set is:

- **Continuity:** preserve the current visual and interaction language while resolving the identified problems.
- **Reduction:** remove everything that is not necessary for the primary task.
- **Character:** pursue a more distinctive product identity while preserving the fixed requirements.

Other useful assignments include expert-density, mobile-first, editorial, accessibility-first, or first-use clarity.

Candidates should work independently during their first pass. Early visibility into the other attempts encourages premature convergence.

## 5. Require comparable evidence

Every candidate should be reviewed against the same material:

- identical seeded data or project state;
- identical viewport sizes;
- the same required user states;
- the same build and verification expectations;
- a branch and exact commit;
- screenshots or recordings captured at matching checkpoints;
- a brief statement of decisions and known compromises.

Useful checkpoints often include initial, normal, dense, selected, loading, empty, error, and narrow-screen states. Interactive or motion-heavy work should include a recording or working preview rather than relying on a single still image.

## 6. Review by decision

Avoid selecting a whole candidate too early. Compare individual decisions:

- Which hierarchy is easiest to understand?
- Which treatment supports the primary action?
- Which remains readable with real, dense data?
- Which is most specific to this product?
- Which behaves best on a narrow screen?
- Which interaction would become irritating through repeated use?
- Which candidate adds learning cost?
- Which elements feel generic, ornamental, or unsupported?
- Which ideas can survive later additions without crowding the surface?

Automated or agent review can check the brief, identify omitted states, flag accessibility concerns, and describe tradeoffs. Human review owns the final taste decision.

## 7. Record a concrete selection

Record accepted and rejected decisions in direct terms. For example:

> Use B’s overall composition and A’s compact filter behavior. Keep the existing typography. Reject C’s card grouping and persistent activity rail. Explore B’s mobile drawer during convergence.

Then choose one canonical branch. Give the convergence pass:

- the original brief;
- the selected branch;
- accepted elements from other candidates;
- rejected directions and the reasons for rejecting them;
- unresolved details;
- the same verification requirements.

Continue refinement on that branch rather than reopening broad divergence for every small decision.

## 8. Stop diverging

Return to a single implementation when:

- the preferred direction can be described clearly;
- new candidates mostly rearrange details;
- the same qualities keep winning;
- remaining concerns can be written as specific changes;
- comparison has moved from concepts to polish.

## Fidelity ladder

The candidate does not always need to be a complete implementation. Choose the lowest-cost artifact that supports a real decision:

1. written direction;
2. rough layout or wireframe;
3. static HTML or screenshot mockup;
4. CSS-only or isolated component variation;
5. working branch;
6. full interactive prototype.

Use working code when behavior, responsiveness, keyboard interaction, state transitions, or motion determines the quality of the answer.

## Lightweight record

Copy this into an issue, task, or temporary note when useful:

```md
# Creative exploration

## Decision to make

## Why alternatives are useful

## Fixed requirements
- 

## Open questions
- 

## References
- Example — relevant quality

## Anti-references
- Pattern — reason to avoid

## Candidates
- A: continuity
- B: reduction
- C: character

## Required states and evidence
- 

## Selection
- Keep:
- Combine:
- Reject:
- Explore during convergence:

## Canonical branch and commit

## Remaining questions
- 
```

## Possible uses in Stensibly

This workflow may be useful for:

- browser-board hierarchy, density, and navigation;
- project-brief and custodian-report presentation;
- names and descriptions for lifecycle operations and MCP tools;
- onboarding and empty-state language;
- explanations of claims, expiration, recovery, handoffs, and permissions;
- future workspace or multi-project interfaces.

Keep ledger semantics, authorization rules, state transitions, and deterministic report facts fixed across candidates. Explore how those facts are organized, explained, and presented.

Stensibly can also coordinate the process itself: one parent item for the exploration, child items for independent candidates, artifact references for branches and screenshots, findings for comparisons, a decision item for the human selection, and a handoff for the convergence pass.