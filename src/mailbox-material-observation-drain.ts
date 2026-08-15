import type {
  DurableMailboxObservationProjection,
  HostedMailboxIntakeService,
} from "./mailbox-intake-convex-service.js";
import type { PostCommitMaterialMailboxObservation } from "./mail-semantic-admission.js";

export interface MaterialGmailObservationConsumer {
  admitMaterialGmailObservation(input: {
    mailboxBindingId: string;
    observation: PostCommitMaterialMailboxObservation;
  }): Promise<unknown>;
}

export interface HostedMailboxMaterialObservationDrainOptions {
  intake: HostedMailboxIntakeService;
  mailboxBindingId: string;
  consumer: MaterialGmailObservationConsumer;
}

export class HostedMailboxMaterialObservationDrain {
  readonly #intake: HostedMailboxIntakeService;
  readonly #mailboxBindingId: string;
  readonly #consumer: MaterialGmailObservationConsumer;

  constructor(options: HostedMailboxMaterialObservationDrainOptions) {
    if (!options?.intake) throw new RangeError("Mailbox material drain intake is required");
    if (!options.consumer || typeof options.consumer.admitMaterialGmailObservation !== "function") {
      throw new RangeError("Mailbox material drain consumer is required");
    }
    this.#intake = options.intake;
    this.#mailboxBindingId = identity(options.mailboxBindingId, "Mailbox binding ID");
    this.#consumer = options.consumer;
  }

  async drainObservationIds(observationIds: readonly string[]): Promise<number> {
    if (!Array.isArray(observationIds) || observationIds.length > 256) {
      throw new RangeError("Mailbox material drain batch is invalid");
    }
    const unique = new Set(observationIds.map((value) => identity(value, "Mailbox observation ID")));
    let drained = 0;
    for (const observationId of unique) {
      const observation = await this.#intake.getMaterialObservation(
        this.#mailboxBindingId,
        observationId,
      );
      if (!observation) {
        throw new Error("Durable material mailbox observation is unavailable by exact identity");
      }
      await this.#consume(observation);
      drained += 1;
    }
    return drained;
  }

  async drainRecent(limit = 100): Promise<number> {
    const recent = await this.#intake.listRecentMaterialObservations(
      this.#mailboxBindingId,
      limit,
    );
    return await this.drainObservationIds(recent.map((observation) => observation.observationId));
  }

  async #consume(observation: DurableMailboxObservationProjection): Promise<void> {
    if (
      observation.provider !== "gmail"
      || observation.wakeEligible !== true
      || observation.loopDisposition !== "ordinary"
      || observation.containsRawContent !== false
      || observation.grantsAuthority !== false
    ) {
      throw new Error("Mailbox material drain received a non-material observation");
    }
    await this.#consumer.admitMaterialGmailObservation({
      mailboxBindingId: this.#mailboxBindingId,
      observation,
    });
  }
}

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length < 1
    || value.length > 1024
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/+=-]*$/u.test(value)
  ) throw new RangeError(`${label} is invalid`);
  return value;
}
