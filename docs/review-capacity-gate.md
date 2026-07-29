# CodeRabbit reviews

CodeRabbit review is **off by default**.

Do not request it for routine work: small fixes, tests, documentation, formatting, generated files, replays, deployment triggers, one-use scripts, or other mechanical changes.

Request a review manually only when both are true:

- the change is genuinely consequential, such as authentication, permissions, privacy, durable data, destructive migration, or broad compatibility;
- meaningful uncertainty remains after reading the diff and running the relevant checks, and another review could realistically change the merge or deployment decision.

Use at most one review on a stable head. Do not request another review for cosmetic follow-ups or unchanged replays.

CI and direct inspection are the normal path. CodeRabbit is reserved for the hard cases.
