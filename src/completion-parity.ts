import type { StensiblyStore } from "./store.js";

const completionParitySql = `
  CREATE TRIGGER IF NOT EXISTS items_clear_next_action_on_completion
  AFTER UPDATE OF status ON items
  WHEN NEW.status = 'done' AND NEW.next_action IS NOT NULL
  BEGIN
    UPDATE items SET next_action = NULL WHERE id = NEW.id;
  END;

  UPDATE items
  SET next_action = NULL
  WHERE status = 'done' AND next_action IS NOT NULL;
`;

export function installSqliteCompletionParity(store: StensiblyStore): void {
  store.db.exec(completionParitySql);
}
