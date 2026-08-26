import {
  dispatchNextWork,
  ensureDispatchSchema,
  type DispatchInput,
  type DispatchResult,
} from "./dispatcher.js";
import {
  NotFoundError,
  type StensiblyStore,
} from "./store.js";

export interface ExactGenerationDispatchInput
  extends Omit<DispatchInput, "itemId" | "idempotencyKey"> {
  itemId: string;
  expectedClaimGeneration: number;
}

export type ExactGenerationDispatchOutcome =
  | {
      readonly status: "dispatched";
      readonly itemId: string;
      readonly expectedClaimGeneration: number;
      readonly result: DispatchResult;
    }
  | {
      readonly status: "stale_generation";
      readonly itemId: string;
      readonly expectedClaimGeneration: number;
      readonly currentClaimGeneration: number;
    }
  | {
      readonly status: "unavailable";
      readonly itemId: string;
      readonly expectedClaimGeneration: number;
    };

/**
 * Dispatch one exact ready item only while it still has the caller's expected
 * claim generation.
 *
 * The outer BEGIN IMMEDIATE transaction is the generation fence. Bun turns the
 * existing dispatcher's nested transaction into a savepoint, so no competing
 * SQLite writer can advance/release the item between this check and the real
 * exact-item claim. This function adds no second dispatcher and owns no replay
 * ledger; durable trigger consumption wraps this primitive separately.
 */
export function dispatchExactWorkAtClaimGeneration(
  store: StensiblyStore,
  rawInput: ExactGenerationDispatchInput,
  now = new Date(),
): ExactGenerationDispatchOutcome {
  const itemId = exactItemId(rawInput.itemId);
  const expectedClaimGeneration = nonNegativeGeneration(
    rawInput.expectedClaimGeneration,
  );
  const project = rawInput.project === undefined
    ? undefined
    : exactProject(rawInput.project);

  // Initialize every schema before acquiring the outer write transaction. The
  // nested dispatch path then reuses the already-initialized schema and its own
  // transaction becomes a savepoint.
  ensureDispatchSchema(store);

  const transaction = store.db.transaction((): ExactGenerationDispatchOutcome => {
    let current;
    try {
      current = store.getItem(itemId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return freeze({
          status: "unavailable" as const,
          itemId,
          expectedClaimGeneration,
        });
      }
      throw error;
    }

    // Preserve the existing exact-item dispatch privacy/availability posture:
    // a foreign project or non-ready item is simply unavailable here.
    if (
      current.status !== "ready"
      || (project !== undefined && current.project !== project)
    ) {
      return freeze({
        status: "unavailable" as const,
        itemId,
        expectedClaimGeneration,
      });
    }

    if (current.claimGeneration !== expectedClaimGeneration) {
      return freeze({
        status: "stale_generation" as const,
        itemId,
        expectedClaimGeneration,
        currentClaimGeneration: current.claimGeneration,
      });
    }

    const {
      expectedClaimGeneration: _expectedClaimGeneration,
      ...dispatchInput
    } = rawInput;
    const result = dispatchNextWork(store, {
      ...dispatchInput,
      ...(project === undefined ? {} : { project }),
      itemId,
    }, now);
    if (!result) {
      return freeze({
        status: "unavailable" as const,
        itemId,
        expectedClaimGeneration,
      });
    }
    if (
      result.item.id !== itemId
      || result.item.claimGeneration !== expectedClaimGeneration + 1
    ) {
      throw new Error("Exact-generation dispatch produced an invalid claim transition");
    }
    return freeze({
      status: "dispatched" as const,
      itemId,
      expectedClaimGeneration,
      result,
    });
  });

  return transaction.immediate();
}

function exactItemId(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 240
    || value.trim() !== value
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)
  ) {
    throw new TypeError("Exact-generation dispatch item ID is invalid");
  }
  return value;
}

function exactProject(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 80
    || value.trim() !== value
    || !/^[a-z0-9][a-z0-9_-]*$/u.test(value)
  ) {
    throw new TypeError("Exact-generation dispatch project is invalid");
  }
  return value;
}

function nonNegativeGeneration(value: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) {
    throw new TypeError(
      "Exact-generation dispatch expected claim generation must be a non-negative safe integer",
    );
  }
  return value;
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen);
  return Object.freeze(value);
}
