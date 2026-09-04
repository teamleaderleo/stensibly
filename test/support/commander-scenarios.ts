import { StensiblyStore } from "../../src/store.ts";

export function commanderScenario(state: "overview" | "completed" | "blocked" | "cleared") {
  const store = new StensiblyStore(":memory:");
  const actor = { id: "fixture", name: "Fixture", kind: "human" as const };
  const item = store.createItem({ project: "commander", kind: "task", title: "Verify the delivered result",
    summary: "The implementation is ready for its acceptance check.", nextAction: "Inspect the exact result and run the acceptance check.", priority: 80, actor });
  for (let i = 0; i < 5; i++) {
    const active = store.createItem({ project: "commander", kind: "task", title: `Healthy work ${i}`,
      summary: "Working within the accepted scope. No operator action required.", priority: 30, actor });
    store.claimItem(active.id, actor, 900);
  }
  store.createItem({ project: "commander", kind: "decision", title: "Choose the acceptance target",
    summary: "Choose which internal project should receive the bounded acceptance test.", nextAction: "Select the internal test project.", priority: 90, actor });
  const history = store.createItem({ project: "commander", kind: "finding", title: "Prior acceptance passed",
    summary: "Historical evidence from the previous result; not current provider health.", priority: 10, actor });
  store.completeItem(history.id, actor, history.claimGeneration, history.summary!);
  if (state === "completed") store.completeItem(item.id, actor, item.claimGeneration, "Acceptance passed; inspect the result before reuse.");
  if (state === "blocked") store.db.query("UPDATE items SET status = 'blocked', summary = ?1, next_action = ?2 WHERE id = ?3")
    .run("Acceptance target unavailable.", "Restore the target or choose another.", item.id);
  if (state === "cleared") store.db.query("UPDATE items SET summary = ?1 WHERE id = ?2")
    .run("Acceptance target recovered; the check can be retried after current admission.", item.id);
  return { store, item };
}
