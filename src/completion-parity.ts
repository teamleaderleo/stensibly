import type { StensiblyStore } from "./store.js";

const completionParitySql = `
  DROP TRIGGER IF EXISTS items_apply_completion_contract;
  DROP TRIGGER IF EXISTS items_clear_next_action_on_completion;

  CREATE TRIGGER items_clear_next_action_on_completion
  BEFORE UPDATE OF status ON items
  WHEN NEW.status = 'done' AND OLD.next_action IS NOT NULL
  BEGIN
    UPDATE items
    SET next_action = NULL
    WHERE id = OLD.id;
  END;

  UPDATE items
  SET next_action = NULL
  WHERE status = 'done' AND next_action IS NOT NULL;
`;

export function installSqliteCompletionParity(store: StensiblyStore): void {
  store.db.exec(completionParitySql);
}
