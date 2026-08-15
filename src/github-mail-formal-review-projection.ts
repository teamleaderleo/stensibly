import * as core from "./github-mail-formal-review-projection-core.js";
import { exactMailboxEffectAuthorityKey } from "./github-mail-effect-authority.js";

export * from "./github-mail-formal-review-projection-core.js";

export interface GitHubMailFormalReviewAuthorityBinding
  extends core.GitHubMailFormalReviewAuthorityBinding {
  /** Exact server-owned #1497 destination; never derive this from visible To/Cc text. */
  readonly expectedMailboxAddress: string;
}

export type GitHubMailFormalReviewInput = Omit<
  core.GitHubMailFormalReviewInput,
  "authority"
> & {
  readonly authority?: GitHubMailFormalReviewAuthorityBinding;
};

/** Formal-review admission uses the same exact mailbox/target trust binding as comments. */
export function classifyGitHubFormalReviewMailReply(
  input: GitHubMailFormalReviewInput,
): core.GitHubMailFormalReviewAdmission {
  const authority = input.authority;
  if (!authority) {
    throw new RangeError("Formal review mail requires a server-owned authority binding");
  }
  if (typeof authority.expectedMailboxAddress !== "string") {
    throw new RangeError(
      "Formal review mail requires an exact server-owned mailbox destination",
    );
  }
  if (
    authority.provider !== input.provider
    || authority.mailboxBindingId !== input.mailboxBindingId
    || authority.threadId !== input.thread.threadId
  ) {
    throw new RangeError("Formal review authority does not match the server-owned mailbox/thread binding");
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
  const coreAuthority: core.GitHubMailFormalReviewAuthorityBinding = {
    ...authority,
    mailboxBindingId: exact.coreMailboxBindingId,
  };
  const admitted = core.classifyGitHubFormalReviewMailReply({
    ...input,
    mailboxBindingId: exact.coreMailboxBindingId,
    authority: coreAuthority,
  });
  return Object.freeze({
    ...admitted,
    mailboxBindingId: input.mailboxBindingId,
  });
}
