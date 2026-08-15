import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import { canonicalJsonString } from "./idempotency-request-fingerprint.js";
import {
  admitMailSemanticAdmissionEvidenceJson,
} from "./mail-semantic-admission-evidence.js";
import type {
  MailSemanticAdmissionEvidence,
  MailSemanticAdmissionStore,
} from "./mail-semantic-admission.js";

const getRef = makeFunctionReference<"query">("mailSemanticAdmission:get");
const admitRef = makeFunctionReference<"mutation">("mailSemanticAdmission:admit");
const listRef = makeFunctionReference<"query">("mailSemanticAdmission:listRecentForThread");

export interface HostedMailSemanticAdmissionStoreOptions {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace?: string;
}

export class HostedMailSemanticAdmissionStore implements MailSemanticAdmissionStore {
  readonly #client: ConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: HostedMailSemanticAdmissionStoreOptions) {
    if (!options?.client) throw new RangeError("Mail semantic Convex client is required");
    this.#client = options.client;
    this.#serviceSecret = required(options.serviceSecret, "Mail semantic service secret");
    this.#workspace = required(options.workspace ?? "default", "Mail semantic workspace");
  }

  async get(input: {
    provider: "gmail";
    mailboxBindingId: string;
    providerMessageId: string;
  }): Promise<MailSemanticAdmissionEvidence | null> {
    if (input.provider !== "gmail") throw new RangeError("Mail semantic provider is invalid");
    const raw = await this.#client.query(getRef, this.#args({
      provider: "gmail",
      mailboxBindingId: required(input.mailboxBindingId, "Mail semantic mailbox binding ID"),
      providerMessageId: required(input.providerMessageId, "Mail semantic provider message ID"),
    }));
    if (raw === null) return null;
    if (typeof raw !== "string") {
      throw new Error("Mail semantic storage returned invalid admission JSON");
    }
    return admitMailSemanticAdmissionEvidenceJson(raw);
  }

  async admit(
    evidence: MailSemanticAdmissionEvidence,
  ): Promise<{ duplicate: boolean; evidence: MailSemanticAdmissionEvidence }> {
    const admitted = admitMailSemanticAdmissionEvidenceJson(canonicalJsonString(evidence));
    const raw = await this.#client.mutation(admitRef, this.#args({
      admissionJson: canonicalJsonString(admitted),
    }));
    const result = record(raw);
    if (typeof result.admissionJson !== "string") {
      throw new Error("Mail semantic storage returned invalid admission JSON");
    }
    const stored = admitMailSemanticAdmissionEvidenceJson(result.admissionJson);
    if (typeof result.duplicate !== "boolean") {
      throw new Error("Mail semantic storage returned invalid replay state");
    }
    return Object.freeze({ duplicate: result.duplicate, evidence: stored });
  }

  async listRecentForThread(
    threadId: string,
    limit = 100,
  ): Promise<readonly MailSemanticAdmissionEvidence[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Mail semantic thread admission limit is invalid");
    }
    const raw = await this.#client.query(listRef, this.#args({
      threadId: required(threadId, "Mail semantic thread ID"),
      limit,
    }));
    if (!Array.isArray(raw)) {
      throw new Error("Mail semantic storage returned invalid thread admissions");
    }
    return Object.freeze(raw.map((entry) => {
      if (typeof entry !== "string") {
        throw new Error("Mail semantic storage returned invalid admission JSON");
      }
      return admitMailSemanticAdmissionEvidenceJson(entry);
    }));
  }

  #args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      serviceSecret: this.#serviceSecret,
      workspace: this.#workspace,
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mail semantic storage returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function required(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length < 1
    || value.length > 64 * 1024
  ) throw new RangeError(`${label} is required`);
  return value;
}
