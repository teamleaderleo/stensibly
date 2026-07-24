import { z } from "zod";
import {
  proposeContinuationSchema,
  type ContinuationLedger,
} from "./continuation-contracts.js";
import type { ContinuationProposal } from "./continuations.js";
import { actorSchema } from "./schemas.js";
import type { Item } from "./store.js";

export const continuationDraftSchema = proposeContinuationSchema.omit({ actor: true });

export const completeWithContinuationsSchema = z.object({
  actor: actorSchema,
  summary: z.string().trim().max(10_000).optional(),
  continuations: z.array(continuationDraftSchema).max(20).optional(),
});

export type ContinuationDraft = z.input<typeof continuationDraftSchema>;

export interface CompleteWithContinuationsInput {
  id: string;
  actor: z.input<typeof actorSchema>;
  summary?: string;
  continuations: ContinuationDraft[];
  idempotencyKey?: string;
}

export interface CompleteWithContinuationsResult {
  item: Item;
  continuations: ContinuationProposal[];
}

export interface CompletionContinuationLedger extends ContinuationLedger {
  completeWorkWithContinuations(
    input: CompleteWithContinuationsInput,
  ): Promise<CompleteWithContinuationsResult>;
}

export function completionContinuationLedger(
  value: unknown,
): CompletionContinuationLedger | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CompletionContinuationLedger>;
  return typeof candidate.completeWorkWithContinuations === "function"
    ? value as CompletionContinuationLedger
    : null;
}
