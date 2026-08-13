import {
  claimSqliteRunnerAdapterCommandRecovery,
  type ClaimRunnerAdapterCommandRecoveryInput,
} from "../../src/runner-adapter-command-recovery.ts";
import { StensiblyStore } from "../../src/store.ts";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("Database path is required");
const input = await Bun.stdin.json() as ClaimRunnerAdapterCommandRecoveryInput & {
  now: string;
};
const { now, ...claimInput } = input;
const store = new StensiblyStore(databasePath);
try {
  const result = claimSqliteRunnerAdapterCommandRecovery(
    store,
    claimInput,
    new Date(now),
  );
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  store.close();
}
