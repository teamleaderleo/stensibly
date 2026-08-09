import { v } from "convex/values";
import {
  assertOperationWorkflowTransition,
  canonicalOperationWorkflowJson,
  fingerprintOperationWorkflow,
  operationWorkflowStableRequestJson,
  parseOperationWorkflowJson,
} from "../src/operation-workflow-admission";
import { findProject, findWorkspace, normalizeWorkspace, requireServiceSecret } from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

export const reserve = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    workflowJson: v.string(),
    workflowSha256: v.string(),
    stableRequestJson: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Operation workflow workspace does not exist");
    const project = await findProject(ctx, workspace._id, args.project);
    if (!project) throw new Error("Operation workflow project does not exist");
    const workflow = parseOperationWorkflowJson(args.workflowJson);
    if (workflow.project !== args.project || workflow.revision !== 1 || workflow.state !== "reserved") {
      throw new Error("Operation workflow reservation is invalid");
    }
    const canonicalJson = canonicalOperationWorkflowJson(workflow);
    const workflowSha256 = fingerprintOperationWorkflow(workflow);
    const stableRequestJson = operationWorkflowStableRequestJson(workflow);
    if (args.workflowJson !== canonicalJson || args.workflowSha256 !== workflowSha256 || args.stableRequestJson !== stableRequestJson) {
      throw new Error("Operation workflow reservation evidence is invalid");
    }
    const existing = await ctx.db
      .query("operationWorkflows")
      .withIndex("by_project_id_and_idempotency_key", (q) =>
        q.eq("projectId", project._id).eq("idempotencyKey", workflow.idempotencyKey))
      .unique();
    if (existing) {
      const stored = admittedStoredWorkflow(existing, args.project);
      return {
        outcome: existing.stableRequestJson === stableRequestJson ? "replay" : "conflict",
        workflowJson: canonicalOperationWorkflowJson(stored),
        workflowSha256: existing.workflowSha256,
      };
    }
    const idReuse = await ctx.db
      .query("operationWorkflows")
      .withIndex("by_workspace_id_and_external_id", (q) =>
        q.eq("workspaceId", workspace._id).eq("externalId", workflow.id))
      .unique();
    if (idReuse) {
      if (idReuse.projectId !== project._id) {
        return { outcome: "conflict", workflowJson: canonicalJson, workflowSha256 };
      }
      const stored = admittedStoredWorkflow(idReuse, args.project);
      return { outcome: "conflict", workflowJson: canonicalOperationWorkflowJson(stored), workflowSha256: idReuse.workflowSha256 };
    }
    await ctx.db.insert("operationWorkflows", {
      workspaceId: workspace._id,
      projectId: project._id,
      externalId: workflow.id,
      idempotencyKey: workflow.idempotencyKey,
      kind: workflow.kind,
      requestSha256: workflow.requestSha256,
      state: workflow.state,
      revision: workflow.revision,
      workflowJson: canonicalJson,
      workflowSha256,
      stableRequestJson,
      createdAt: Date.parse(workflow.createdAt),
      updatedAt: Date.parse(workflow.updatedAt),
    });
    return { outcome: "reserved", workflowJson: canonicalJson, workflowSha256 };
  },
});

export const transition = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    idempotencyKey: v.string(),
    currentSha256: v.string(),
    nextWorkflowJson: v.string(),
    nextWorkflowSha256: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Operation workflow workspace does not exist");
    const project = await findProject(ctx, workspace._id, args.project);
    if (!project) throw new Error("Operation workflow project does not exist");
    const current = await ctx.db
      .query("operationWorkflows")
      .withIndex("by_project_id_and_idempotency_key", (q) =>
        q.eq("projectId", project._id).eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (!current || current.workflowSha256 !== args.currentSha256) {
      throw new Error("Operation workflow durable state changed");
    }
    const currentWorkflow = admittedStoredWorkflow(current, args.project);
    const next = parseOperationWorkflowJson(args.nextWorkflowJson);
    assertOperationWorkflowTransition(currentWorkflow, next);
    const nextJson = canonicalOperationWorkflowJson(next);
    const nextSha256 = fingerprintOperationWorkflow(next);
    if (args.nextWorkflowJson !== nextJson || args.nextWorkflowSha256 !== nextSha256) {
      throw new Error("Operation workflow transition evidence is invalid");
    }
    await ctx.db.patch(current._id, {
      state: next.state,
      revision: next.revision,
      workflowJson: nextJson,
      workflowSha256: nextSha256,
      updatedAt: Date.parse(next.updatedAt),
    });
    return { workflowJson: nextJson, workflowSha256: nextSha256 };
  },
});

export const get = query({
  args: { ...serviceArgs, project: v.string(), idempotencyKey: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const project = await findProject(ctx, workspace._id, args.project);
    if (!project) return null;
    const current = await ctx.db
      .query("operationWorkflows")
      .withIndex("by_project_id_and_idempotency_key", (q) =>
        q.eq("projectId", project._id).eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (!current) return null;
    const workflow = admittedStoredWorkflow(current, args.project);
    return { workflowJson: canonicalOperationWorkflowJson(workflow), workflowSha256: current.workflowSha256 };
  },
});

function admittedStoredWorkflow(
  row: {
    externalId: string;
    idempotencyKey: string;
    kind: string;
    requestSha256: string;
    state: string;
    revision: number;
    workflowJson: string;
    workflowSha256: string;
    stableRequestJson: string;
    createdAt: number;
    updatedAt: number;
  },
  project: string,
) {
  const workflow = parseOperationWorkflowJson(row.workflowJson);
  if (
    workflow.project !== project
    || workflow.id !== row.externalId
    || workflow.idempotencyKey !== row.idempotencyKey
    || workflow.kind !== row.kind
    || workflow.requestSha256 !== row.requestSha256
    || workflow.state !== row.state
    || workflow.revision !== row.revision
    || Date.parse(workflow.createdAt) !== row.createdAt
    || Date.parse(workflow.updatedAt) !== row.updatedAt
    || operationWorkflowStableRequestJson(workflow) !== row.stableRequestJson
    || canonicalOperationWorkflowJson(workflow) !== row.workflowJson
    || fingerprintOperationWorkflow(workflow) !== row.workflowSha256
  ) {
    throw new Error("Operation workflow stored evidence is invalid");
  }
  return workflow;
}
