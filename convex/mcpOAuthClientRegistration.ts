import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { mutation } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const tokenEndpointAuthMethod = v.literal("none");
const publicClientValidator = v.object({
  clientId: v.string(),
  clientName: v.string(),
  redirectUris: v.array(v.string()),
  tokenEndpointAuthMethod,
  grantTypes: v.array(v.string()),
  responseTypes: v.array(v.string()),
  createdAt: v.string(),
});
const registrationResultValidator = v.union(
  v.object({ status: v.literal("ok"), client: publicClientValidator }),
  v.object({ status: v.literal("retryable") }),
  v.object({ status: v.literal("limit") }),
);

const lifecycleRegisterRef = makeFunctionReference<"mutation">(
  "mcpOAuthClientLifecycle:registerClient",
);

export const registerClient = mutation({
  args: {
    ...serviceArgs,
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    tokenEndpointAuthMethod,
    grantTypes: v.array(v.string()),
    responseTypes: v.array(v.string()),
  },
  returns: registrationResultValidator,
  handler: async (ctx, args) => await ctx.runMutation(lifecycleRegisterRef, args) as
    | { status: "ok"; client: {
        clientId: string;
        clientName: string;
        redirectUris: string[];
        tokenEndpointAuthMethod: "none";
        grantTypes: string[];
        responseTypes: string[];
        createdAt: string;
      } }
    | { status: "retryable" }
    | { status: "limit" },
});
