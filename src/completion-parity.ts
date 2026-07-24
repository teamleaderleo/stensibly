import type { StensiblyStore } from "./store.js";

const completionParityTrigger = `
  DROP TRIGGER IF EXISTS items_clear_next_action_on_completion;
  CREATE TRIGGER IF NOT EXISTS items_apply_completion_contract
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
`;

export function installSqliteCompletionParity(store: StensiblyStore): void {
  store.db.exec(completionParityTrigger);
}
