export const reservedItemControlEventTypes = [
  "claim.created",
  "run.queued",
] as const;

const reservedItemControlEventTypeSet = new Set<string>(reservedItemControlEventTypes);

export function isReservedItemControlEventType(value: unknown): boolean {
  return typeof value === "string" && reservedItemControlEventTypeSet.has(value.trim());
}

export function assertPublicRecordableItemEventType(value: string): void {
  if (isReservedItemControlEventType(value)) {
    throw new Error(`Event type ${value.trim()} is reserved for internal lifecycle writers`);
  }
}
