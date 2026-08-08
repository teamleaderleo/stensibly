import { SqliteWorkLedger } from "../../src/sqlite-ledger.ts";
import { StensiblyStore } from "../../src/store.ts";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("SQLite path is required");
const input = JSON.parse(await Bun.stdin.text());
const store = new StensiblyStore(databasePath);
try {
  const ledger = new SqliteWorkLedger(store);
  const result = await ledger.reserveRunnerAdapterCommand(input);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
} finally {
  store.close();
}
