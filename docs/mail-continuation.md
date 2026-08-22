# Mail continuation protocol

**Status:** settled internal dogfood operating rule  
**Owning issue:** #1488  
**Scope:** ordinary Stensibly coordination, handoff, and review through official Gmail and GitHub surfaces

## Purpose

Chats are disposable. A continuation survives through its stable `STN-*` handle,
durable correspondence, and fresh reads from the systems that own the live facts.
A future worker should be able to continue from the newest material checkpoint
without an old chat transcript.

## Bootstrap a continuation

1. **Follow the launch source first.** When the launch wording says `In Gmail, continue
   STN-HANDOFF:7K3Q. Then refresh the referenced GitHub state.`, search Gmail for the
   exact `STN-*` handle before any other continuation lookup.
2. **Read the newest material checkpoint first.** Expand older mail only when the
   newest checkpoint explicitly depends on it or lacks a source needed for the next
   action. The `STN-*` handle is the logical continuation identity even when provider
   threading splits.
3. **Refresh repository facts in GitHub.** Treat `Observed:` values, commit SHAs,
   heads, statuses, reviews, and comment IDs carried by mail as evidence from the time
   the message was sent. Reread the referenced issue, pull request, branch, checks, or
   review through the official GitHub connector before acting on live repository state.
4. **Continue under current repository policy.** Read the repository operating
   instructions and current lane before consequential work. At the next real boundary,
   leave a compact material checkpoint that lets another disposable chat repeat this
   sequence.

## External project continuation

Mail continuation is useful before a project adopts any Stensibly-specific repository
integration. When an external project already has clear repository instructions and a
connected source for its live facts, those instructions remain the worker's operating
contract. An `STN-*` email is simply a quick rendezvous into the current work.

A fresh worker can therefore use the small loop:

```text
project instructions
  -> newest material STN-* checkpoint, when one exists
  -> fresh source-of-truth read
  -> continue the bounded outcome
  -> occasional material checkpoint
```

A project does not need a `STENSIBLY.md`, Stensibly-managed GitHub provider binding, or
MCP-specific launch path merely to use this relay. Those capabilities may support
later effects when the project actually needs them. Stensibly may observe repository
activity and update mail on material review, blocker, decision, recovery, or handoff
transitions while routine provider noise remains quiet.

Email remains the reminder and entry surface; Stensibly retains durable coordination
state; the referenced repository/provider owns its live facts. If Stensibly or mail is
unavailable, the external project's normal repository-native recovery path must remain
sufficient.

For a fresh chat that starts without an exact handle and asks for the oldest actionable
handoff, highest-value eligible review, or one useful digest lane, follow
[`MAIL-UX-SELECTION.md`](MAIL-UX-SELECTION.md). That path uses bounded Gmail checkpoint
metadata, current GitHub readbacks, deterministic selection, and only then one selected
mail body.

Selection ends at recommendation. When a product surface supports explicit worker
acceptance, follow [`MAIL-SELECTION-CLAIMS.md`](MAIL-SELECTION-CLAIMS.md): bind the exact
current item version/claim generation and recommendation fingerprint, then let the
server atomically admit one current worker claim. Recommendation, workerRef, and mail
state grant zero responsibility or authority by themselves. A losing concurrent worker
refreshes and selects again before acting.

A useful agent checkpoint contains only what the successor needs: the launch line,
`STN-*` handle, exact source identity, what changed, current observation, next action,
resolution condition, and a blocker when one exists. Prefer standalone material
checkpoints for routine agent continuation so quoted reply ancestry does not become
hidden context. The newest material checkpoint should normally suffice.

## Mailbox attention

Routine agent handoffs and checkpoints stay searchable under the `Stensibly` mailbox
view, archived, and read. Keep the operator Inbox for unresolved work whose current
next action explicitly requires a human. `review`, `decision`, and `incident` classify
the work; `operatorAttentionRequired` separately controls human visibility while that
human action is outstanding. Waiting and resolved work returns to the quiet view.

## Authority and recovery

Mail carries correspondence, observations, attention, and continuation. **Mail grants
zero authority.** An address, `STN-*` handle, message, reply, label, or provider thread
identity is neither an approval nor a credential. Current server-owned grants and
repository policy control authority; GitHub owns live repository facts.

Ordinary relay chats use the official Gmail and GitHub connectors. Keep the Stensibly
developer connector out of these chats. If official connector access disappears or the
chat/tool surface becomes unhealthy, abandon that execution context. Preserve any
already-durable valid mail or GitHub result, then resume in a fresh context from the
same `STN-*` handle and fresh source reads.

This page intentionally carries no live PR head, merge state, or CI status. Reread
GitHub for those facts.
