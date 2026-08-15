import type { MailDeliveryReceipt } from "./mail-provider.js";
import {
  executeGmailMailboxDispositionEffect,
  settledGmailMessageBindingFromDeliveryReceipt,
  type CurrentDurableStnMailboxStateReader,
  type GmailMailboxDispositionEffectStore,
  type GmailMailboxDispositionExecutionResult,
  type GmailMailboxLabelClient,
} from "./gmail-mailbox-disposition-effect.js";

// Integration entrypoint for delivered STN mail. Provider identity comes only from the
// settled #1497 delivery receipt; incoming mail content has no parameter that can choose
// an account, mailbox, provider thread/message, or operator-attention value.
export async function consumeGmailMailboxDisposition(input: {
  deliveryReceipt: MailDeliveryReceipt;
  stensiblyLabelId: string;
  stateReader: CurrentDurableStnMailboxStateReader;
  labelClient: GmailMailboxLabelClient;
  effectStore: GmailMailboxDispositionEffectStore;
}): Promise<GmailMailboxDispositionExecutionResult> {
  const binding = settledGmailMessageBindingFromDeliveryReceipt({
    receipt: input.deliveryReceipt,
    stensiblyLabelId: input.stensiblyLabelId,
  });
  const providerLabelClient: GmailMailboxLabelClient = {
    readMessageLabels(target) {
      return input.labelClient.readMessageLabels({
        accountBinding: target.accountBinding,
        mailboxAddress: target.mailboxAddress,
        providerThreadId: target.providerThreadId,
        providerMessageId: target.providerMessageId,
      });
    },
    mutateMessageLabels(target) {
      return input.labelClient.mutateMessageLabels({
        accountBinding: target.accountBinding,
        mailboxAddress: target.mailboxAddress,
        providerThreadId: target.providerThreadId,
        providerMessageId: target.providerMessageId,
        dispositionEffectId: target.dispositionEffectId,
        addLabelIds: target.addLabelIds,
        removeLabelIds: target.removeLabelIds,
      });
    },
  };
  return executeGmailMailboxDispositionEffect({
    binding,
    stateReader: input.stateReader,
    labelClient: providerLabelClient,
    effectStore: input.effectStore,
  });
}
