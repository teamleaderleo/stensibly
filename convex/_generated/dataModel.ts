// Generated-compatible type surface derived directly from convex/schema.ts.
// `convex dev` may replace this file with Convex's standard generated output.
export type { DataModel } from "../lib/dataModel";

import type {
  DocumentByName,
  TableNamesInDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";
import type { DataModel } from "../lib/dataModel";

export type TableNames = TableNamesInDataModel<DataModel>;
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;
export type Id<TableName extends TableNames> = GenericId<TableName>;
