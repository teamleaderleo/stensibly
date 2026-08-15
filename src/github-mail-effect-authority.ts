import { boundedText, normalizeGitHubRepository, positiveInteger } from "./github-provider-validation.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import { freezeMailboxBinding } from "./mail-provider.js";
import type { GitHubMailThreadBinding } from "./github-mail-bridge-core.js";

export interface ExactMailboxEffectAuthorityInput {
  readonly provider: "gmail" | "outlook";
  readonly mailboxBindingId: string;
  readonly expectedMailboxAddress: string;
  readonly providerThreadId: string;
  readonly providerMessageId: string;
  readonly inReplyToMessageId: string;
  readonly thread: GitHubMailThreadBinding;
}

/**
 * Produces the internal mailbox-binding key consumed by the #1517 core.
 *
 * The key is deliberately a digest, not a display address. It makes the existing
 * #1517 reply/effect fingerprints transitively bind the exact #1497 mailbox
 * destination, current provider message, provider ancestry, and canonical GitHub
 * target without letting visible To/Cc/From text become authority.
 */
export function exactMailboxEffectAuthorityKey(
  input: ExactMailboxEffectAuthorityInput,
): { readonly coreMailboxBindingId: string; readonly expectedMailboxAddress: string } {
  const mailbox = freezeMailboxBinding({
    provider: input.provider,
    accountBinding: input.mailboxBindingId,
    mailboxAddress: input.expectedMailboxAddress,
  });
  const providerThreadId = boundedText(
    input.providerThreadId,
    "Provider mail thread ID",
    512,
  );
  const providerMessageId = boundedText(
    input.providerMessageId,
    "Provider mail message ID",
    512,
  );
  const inReplyToMessageId = boundedText(
    input.inReplyToMessageId,
    "Provider mail parent message ID",
    512,
  );
  const threadId = boundedText(input.thread.threadId, "STN thread ID", 240);
  const project = boundedText(input.thread.project, "STN project", 160);
  const repository = normalizeGitHubRepository(input.thread.repository);
  const pullRequestNumber = positiveInteger(
    input.thread.pullRequestNumber,
    "GitHub pull request number",
  );
  const fingerprint = fingerprintCanonicalRequest({
    threadId,
    provider: mailbox.provider,
    mailboxBindingId: mailbox.accountBinding,
    expectedMailboxAddress: mailbox.mailboxAddress,
    providerThreadId,
    providerMessageId,
    inReplyToMessageId,
    project,
    repository,
    pullRequestNumber,
  });
  return Object.freeze({
    coreMailboxBindingId: `mail-authority:${fingerprint.slice("sha256:".length)}`,
    expectedMailboxAddress: mailbox.mailboxAddress,
  });
}
