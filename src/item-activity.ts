import { NotFoundError, type StensiblyStore } from "./store.js";

export function hasRecordedIdempotencyKey(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
): boolean {
  if (!idempotencyKey) return false;
  return Boolean(
    store.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM events WHERE idempotency_key = ?1",
      )
      .get(idempotencyKey),
  );
}

export function touchItemActivity(
  store: StensiblyStore,
  itemId: string,
  updatedAt: string,
): void {
  const result = store.db
    .query(`
      UPDATE items
      SET version = version + 1,
          updated_at = ?1
      WHERE id = ?2
    `)
    .run(updatedAt, itemId);

  if (result.changes !== 1) {
    throw new NotFoundError(`Item ${itemId} does not exist`);
  }
}
