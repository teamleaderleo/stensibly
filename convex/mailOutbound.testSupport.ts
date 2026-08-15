import { sha256 } from "../src/canonical-json";
import { ConvexMailThreadStore } from "../src/convex-mail-thread-store";
import { InMemoryMailProvider } from "../src/in-memory-mail-provider";
import {
  MailOutboundService,
  type PublishMailThreadCommand,
} from "../src/mail-outbound-service";
import { createMailThreadHandle, type MailThreadClass } from "../src/mail-thread-contract";
import type {
  MailDeliveryReceipt,
  MailOutboundEffectRecord,
  MailProviderProjection,
} from "../src/mail-provider";
import type { MailThreadStore } from "../src/mail-thread-store";

export const serviceSecret = "hosted-outbound-test-secret";
export const workspace = "test";
export const mailbox = Object.freeze({
  provider: "gmail",
  accountBinding: "gmail_operator_primary",
  mailboxAddress: "operator@example.com",
});

export function caller(t: any) {
  return {
    query: async (reference: any, args: Record<string, unknown>) => await t.query(reference, args),
    mutation: async (reference: any, args: Record<string, unknown>) => await t.mutation(reference, args),
  };
}

export function hostedStore(t: any): ConvexMailThreadStore {
  return new ConvexMailThreadStore({ client: caller(t), serviceSecret, workspace });
}

export async function seedWorkspace(t: any) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("workspaces", {
      externalId: "ws_test",
      slug: workspace,
      name: "Test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

export function command(
  sourceIdentity: string,
  overrides: Partial<PublishMailThreadCommand> = {},
): PublishMailThreadCommand {
  return {
    workspace,
    project: "stensibly",
    threadClass: "handoff",
    sourceIdentity,
    canonicalSubject: "Hosted outbound continuation",
    sourceFingerprint: sha256(`${sourceIdentity}:v1`),
    whatChanged: "The hosted continuation is ready.",
    attentionReason: "A durable worker continuation is ready.",
    nextAction: "Refresh the referenced GitHub state and continue.",
    sourceObject: "github:teamleaderleo/stensibly#1518",
    sourceRevision: "a".repeat(40),
    blocker: null,
    resolutionCondition: "Hosted continuation is accepted.",
    threadState: "open",
    continuationRoute: { mailProvider: "Gmail", sourceSystem: "GitHub" },
    mailbox,
    ...overrides,
  };
}

export function outboundService(
  store: MailThreadStore,
  provider: InMemoryMailProvider,
  input: { threadId?: string; handle?: string; now?: string } = {},
): MailOutboundService {
  return new MailOutboundService({
    store,
    provider,
    now: () => input.now ?? "2026-08-15T07:30:00.000Z",
    threadIdFactory: () => input.threadId ?? "mail_thread_hosted",
    handleFactory: (threadClass: MailThreadClass) =>
      createMailThreadHandle(threadClass, input.handle ?? "K8R4"),
  });
}

export class FaultStore implements MailThreadStore {
  lastReservation: MailOutboundEffectRecord | null = null;
  fired = false;

  constructor(
    readonly inner: MailThreadStore,
    readonly mode: "before_reservation" | "after_reservation" | "before_sent_settlement" | "after_sent_settlement",
  ) {}

  reserveThread(...args: Parameters<MailThreadStore["reserveThread"]>) { return this.inner.reserveThread(...args); }
  getThreadByHandle(...args: Parameters<MailThreadStore["getThreadByHandle"]>) { return this.inner.getThreadByHandle(...args); }
  getThreadBySource(...args: Parameters<MailThreadStore["getThreadBySource"]>) { return this.inner.getThreadBySource(...args); }
  updateThread(...args: Parameters<MailThreadStore["updateThread"]>) { return this.inner.updateThread(...args); }
  getProviderProjection(...args: Parameters<MailThreadStore["getProviderProjection"]>) { return this.inner.getProviderProjection(...args); }
  getDeliveryEffect(...args: Parameters<MailThreadStore["getDeliveryEffect"]>) { return this.inner.getDeliveryEffect(...args); }
  getDeliveryEffectByProviderMessageId(...args: Parameters<MailThreadStore["getDeliveryEffectByProviderMessageId"]>) {
    return this.inner.getDeliveryEffectByProviderMessageId(...args);
  }

  async reserveDeliveryEffect(effect: MailOutboundEffectRecord) {
    if (!this.fired && this.mode === "before_reservation") {
      this.fired = true;
      throw new Error("simulated crash before reservation");
    }
    const reservation = await this.inner.reserveDeliveryEffect(effect);
    this.lastReservation = reservation.effect;
    if (!this.fired && this.mode === "after_reservation") {
      this.fired = true;
      throw new Error("simulated crash after reservation");
    }
    return reservation;
  }

  async settleDeliveryEffect(input: {
    effect: MailOutboundEffectRecord;
    receipt: MailDeliveryReceipt;
    projection?: MailProviderProjection | null;
  }) {
    const successful = input.receipt.result === "sent" || input.receipt.result === "reconciled";
    if (!this.fired && successful && this.mode === "before_sent_settlement") {
      this.fired = true;
      throw new Error("simulated crash before settlement");
    }
    const settled = await this.inner.settleDeliveryEffect(input);
    if (!this.fired && successful && this.mode === "after_sent_settlement") {
      this.fired = true;
      throw new Error("simulated crash after settlement");
    }
    return settled;
  }
}
