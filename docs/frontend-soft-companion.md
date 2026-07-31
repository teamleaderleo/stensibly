# Soft Companion prototype rationale

**Programme:** #605  
**Owner issue:** #608  
**Fixture dependency:** #607 / PR #670 classic bridge  
**Status:** fixture-only Labs prototype

## Design thesis

Soft Companion tests whether operational work can feel warm, tactile, and gently alive while preserving exact state, evidence, and recovery behavior.

The route uses a room-and-desk metaphor:

- the selected project is a persistent room;
- Today, Workers, Ready, and Recover are labeled desk drawers;
- work remains a compact card list with persistent detail;
- connection health stays visible at the top of the desk;
- preview scenarios are explicit local controls;
- all five shared tasks remain reachable through the command menu and exact fixture identities.

## Companion role

Mallow is an original paper-moth creature drawn entirely with repository-authored HTML and CSS primitives. No third-party artwork, font, image, icon file, SVG, or copied character design is included.

The companion has three bounded jobs:

1. reinforce calm, concern, completion, loading, and error feedback;
2. restate the selected card’s literal state and next action;
3. reward a reversible preview acknowledgement with restrained motion.

Mallow never replaces the state label, disposition, health text, evidence identity, or next action. Ambiguous operations keep the explicit “Reconcile before retry” language and the primary control performs no simulated retry.

## Applied research

The first #615 synthesis recommends three Soft Companion experiments:

- pair an original companion reaction with literal status and test state comprehension;
- compare restrained completion motion with reduced motion and no motion;
- test whether warmth improves return-to-work confidence without slowing error recognition.

This slice implements the surfaces required to run those experiments. It also follows the broader findings to keep command access beside visible controls, make mode changes explicit and reversible, and keep personality separate from operational truth.

## State and interaction coverage

- default, empty, loading, degraded, and error presentation through `?scenario=` and a visible local selector;
- light and evening color systems through semantic custom properties;
- reduced-motion rules that stop companion, sparkle, loading, hover, and scroll animation;
- wide, medium, narrow, and zoom-friendly reflow without hidden task actions;
- 1–4 drawer switching, J/K and arrow card movement, Enter detail, Escape return, slash and Command/Control-K command access;
- Arrow Up/Down, Home, End, Enter, and Escape command navigation;
- focus restoration after command dismissal and narrow-screen detail return;
- reversible preview acknowledgement for ordinary cards;
- fail-closed ambiguous-operation behavior that announces the safe action and performs no retry.

## Known risks

- warmth can consume vertical space; browser evidence should compare completion time and scroll distance with Quiet Control;
- a companion can become repetitive; evaluation should test comfort after repeated task runs, not only first impressions;
- the room metaphor may weaken at high project counts; future work should preserve text search and a scalable project list;
- color and rounded surfaces can reduce density; 200% zoom and narrow evidence should verify state scanning and target access;
- CSS artwork can drift across engines; literal text remains the accepted evidence path.

## Recovery

The route uses fictional local records and performs no network or durable action. Revert the Soft Companion route, rationale, manifest metadata, and focused test to restore the planned placeholder.
