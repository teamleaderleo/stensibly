// Generated-compatible type surface derived directly from convex/schema.ts.
// `convex dev` may replace this file with Convex's standard generated output.
export type { DataModel } from "../lib/dataModel";

import type { DataModel } from "../lib/dataModel";
import type {
  DocumentByName,
  Id,
  TableNamesInDataModel,
} from "convex/server";

export type TableNames = TableNamesInDataModel<DataModel>;
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;
export type { Id };
