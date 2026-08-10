import type { ConvexCaller } from "./convex-ledger.js";
import {
  ConvexProjectRepositorySetupObservationLedger,
} from "./project-repository-setup-observation-convex.js";
import type {
  ProjectRepositorySetupObservationLedger,
} from "./project-repository-setup-observation.js";
import {
  SqliteProjectRepositorySetupObservationLedger,
} from "./project-repository-setup-observation-sqlite.js";
import type { WorkLedger } from "./ledger.js";
import type { StensiblyStore } from "./store.js";

export function projectRepositorySetupObservationLedger(
  ledger: WorkLedger,
): ProjectRepositorySetupObservationLedger | null {
  const convex = convexBackendFor(ledger);
  if (convex) return new ConvexProjectRepositorySetupObservationLedger(convex);
  const sqliteStore = sqliteStoreFor(ledger);
  return sqliteStore
    ? new SqliteProjectRepositorySetupObservationLedger(sqliteStore)
    : null;
}

function convexBackendFor(ledger: WorkLedger): {
  client: ConvexCaller;
  serviceSecret: string;
  workspace: string;
} | null {
  try {
    const client = Reflect.get(ledger as object, "client") as unknown;
    const serviceSecret = Reflect.get(ledger as object, "serviceSecret") as unknown;
    const workspace = Reflect.get(ledger as object, "workspace") as unknown;
    if (
      !client
      || typeof client !== "object"
      || typeof Reflect.get(client, "query") !== "function"
      || typeof Reflect.get(client, "mutation") !== "function"
      || typeof serviceSecret !== "string"
      || serviceSecret.length < 1
      || typeof workspace !== "string"
      || workspace.length < 1
    ) return null;
    return { client: client as ConvexCaller, serviceSecret, workspace };
  } catch {
    return null;
  }
}

function sqliteStoreFor(ledger: WorkLedger): StensiblyStore | null {
  try {
    const store = Reflect.get(ledger as object, "store") as unknown;
    if (!store || typeof store !== "object") return null;
    const db = Reflect.get(store, "db") as unknown;
    if (
      !db
      || typeof db !== "object"
      || typeof Reflect.get(db, "query") !== "function"
      || typeof Reflect.get(db, "exec") !== "function"
    ) return null;
    return store as StensiblyStore;
  } catch {
    return null;
  }
}
