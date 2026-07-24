import type { StensiblyStore } from "./store.js";

const completionParitySql = `
  DROP TRIGGER IF EXISTS items_apply_completion_contract;
  DROP TRIGGER IF EXISTS items_clear_next_action_on_completion;

  CREATE TRIGGER items_apply_completion_contract
  BEFORE UPDATE OF status ON items
  WHEN NEW.status = 'done' AND NEW.next_action IS NOT NULL
  BEGIN
    UPDATE items
    SET status = NEW.status,
        summary = NEW.summary,
        next_action = NULL,
        claimed_by = NEW.claimed_by,
        claim_expires_at = NEW.claim_expires_at,
        version = NEW.version,
        updated_at = NEW.updated_at
    WHERE id = OLD.id;
    SELECT RAISE(IGNORE);
  END;

  UPDATE items
  SET next_action = NULL
  WHERE status = 'done' AND next_action IS NOT NULL;
`;

export function installSqliteCompletionParity(store: StensiblyStore): void {
  store.db.exec(completionParitySql);
}
