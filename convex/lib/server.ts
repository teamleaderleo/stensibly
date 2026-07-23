import {
  actionGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";

// These generic wrappers let the backend typecheck before a developer runs
// `convex dev` and generates deployment-specific helpers. Convex codegen may
// replace imports with ./_generated/server later without changing behavior.
export const query = queryGeneric;
export const mutation = mutationGeneric;
export const action = actionGeneric;
export const internalQuery = internalQueryGeneric;
export const internalMutation = internalMutationGeneric;
export const internalAction = internalActionGeneric;
