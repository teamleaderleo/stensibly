import * as core from "./github-mail-bridge-core.js";
import { exactMailboxEffectAuthorityKey } from "./github-mail-effect-authority.js";

export * from "./github-mail-bridge-core.js";

export interface GitHubMailReplyAuthorityBinding
  extends core.GitHubMailReplyAuthorityBinding {
  /** Exact server-owned #1497 destination; never derive this from visible To/Cc text. */
  readonly expectedMailboxAddress: string;
}

export type GitHubMailReplyInput = Omit<
  core.GitHubMailReplyInput,
  "authority"
> & {
  readonly authority?: GitHubMailReplyAuthorityBinding;
};

/**
 * Public shared mail-effect admission.
 *
 * #1517 remains the semantic core. This outer fence adds the merged #1497 exact
 * destination plus current provider-message/canonical-target identity to the
 * authority digest before the core can construct any GitHub effect.
 */
export function classifyGitHubMailReply(
  input: GitHubMailReplyInput,
): core.GitHubMailReplyAdmission {
  const effectBearing = input.replyClass === "mail.github_comment_proposal"
    || input.replyClass === "mail.github_review_proposal";
  if (!effectBearing) {
    return core.classifyGitHubMailReply(input);
  }
  const authority = input.authority;
  if (!authority) {
    throw new RangeError("Effect-bearing mail replies require a server-owned authority binding");
  }
  if (typeof authority.expectedMailboxAddress !== "string") {
    throw new RangeError(
      "Effect-bearing mail replies require an exact server-owned mailbox destination",
    );
  }
  if (
    authority.provider !== input.provider
    || authority.mailboxBindingId !== input.mailboxBindingId
    || authority.threadId !== input.thread.threadId
  ) {
    throw new RangeError("Mail reply authority does not match the server-owned mailbox/thread binding");
  }
  const exact = exactMailboxEffectAuthorityKey({
    provider: input.provider,
    mailboxBindingId: input.mailboxBindingId,
    expectedMailboxAddress: authority.expectedMailboxAddress,
    providerThreadId: input.providerThreadId,
    providerMessageId: input.providerMessageId,
    inReplyToMessageId: input.inReplyToMessageId,
    thread: input.thread,
  });
  const coreAuthority: core.GitHubMailReplyAuthorityBinding = {
    ...authority,
    mailboxBindingId: exact.coreMailboxBindingId,
  };
  const admitted = core.classifyGitHubMailReply({
    ...input,
    mailboxBindingId: exact.coreMailboxBindingId,
    authority: coreAuthority,
  });
  return Object.freeze({
    ...admitted,
    mailboxBindingId: input.mailboxBindingId,
  });
}
