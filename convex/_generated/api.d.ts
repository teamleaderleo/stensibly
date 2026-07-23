/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as artifacts from "../artifacts.js";
import type * as claims from "../claims.js";
import type * as dependencies from "../dependencies.js";
import type * as events from "../events.js";
import type * as items from "../items.js";
import type * as lib_claimState from "../lib/claimState.js";
import type * as lib_dataModel from "../lib/dataModel.js";
import type * as lib_domain from "../lib/domain.js";
import type * as lib_server from "../lib/server.js";
import type * as lib_validators from "../lib/validators.js";
import type * as migration from "../migration.js";
import type * as projects from "../projects.js";
import type * as refs from "../refs.js";
import type * as reservations from "../reservations.js";
import type * as runs from "../runs.js";
import type * as tokens from "../tokens.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  artifacts: typeof artifacts;
  claims: typeof claims;
  dependencies: typeof dependencies;
  events: typeof events;
  items: typeof items;
  "lib/claimState": typeof lib_claimState;
  "lib/dataModel": typeof lib_dataModel;
  "lib/domain": typeof lib_domain;
  "lib/server": typeof lib_server;
  "lib/validators": typeof lib_validators;
  migration: typeof migration;
  projects: typeof projects;
  refs: typeof refs;
  reservations: typeof reservations;
  runs: typeof runs;
  tokens: typeof tokens;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
