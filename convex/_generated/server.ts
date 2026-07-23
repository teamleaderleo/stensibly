// Generated-compatible server helpers available before cloud codegen.
// `convex dev` may replace this file with Convex's standard generated output.
import type {
  GenericActionCtx,
  GenericDatabaseReader,
  GenericDatabaseWriter,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { DataModel } from "../lib/dataModel";

export {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../lib/server";

export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;
export type DatabaseReader = GenericDatabaseReader<DataModel>;
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;
