import {
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  admitMcpSetupEvidence,
  type McpSetupEvidence,
  type McpSetupEvidenceReader,
  type McpSetupFirstReadRecorder,
} from "./mcp-setup-evidence.js";
import type { McpSetupConnectionInput } from "./mcp-oauth-service.js";

export interface ConvexMcpSetupEvidenceServiceOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace: string;
}

const recordConnectionRef = makeFunctionReference<"mutation">(
  "mcpSetupEvidence:recordConnection",
);
const recordFirstReadRef = makeFunctionReference<"mutation">(
  "mcpSetupEvidence:recordFirstRead",
);
const getEvidenceRef = makeFunctionReference<"query">(
  "mcpSetupEvidence:getEvidence",
);

export class ConvexMcpSetupEvidenceService implements
  McpSetupEvidenceReader,
  McpSetupFirstReadRecorder
{
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexMcpSetupEvidenceServiceOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = exactWorkspace(options.workspace);
  }

  async recordSetupConnection(input: McpSetupConnectionInput): Promise<void> {
    await this.mutate(recordConnectionRef, input);
  }

  async recordSetupFirstRead(input: {
    accountId: string;
    project: string;
  }): Promise<void> {
    await this.mutate(recordFirstReadRef, input);
  }

  async getMcpSetupEvidence(input: {
    accountId: string;
    project: string;
  }): Promise<McpSetupEvidence> {
    let result: unknown;
    try {
      result = await this.client.query(
        getEvidenceRef,
        this.args(input),
      );
    } catch {
      throw new Error("MCP setup evidence storage failed");
    }
    try {
      return admitMcpSetupEvidence(result, input);
    } catch {
      throw new Error("MCP setup evidence storage failed");
    }
  }

  private async mutate(
    reference: FunctionReference<"mutation">,
    input: object,
  ): Promise<void> {
    try {
      await this.client.mutation(reference, this.args(input));
    } catch {
      throw new Error("MCP setup evidence storage failed");
    }
  }

  private args(input: object): Record<string, unknown> {
    return {
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
      ...input,
    };
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function exactWorkspace(value: string): string {
  if (
    value !== value.trim()
    || value.length > 80
    || !/^[a-z0-9][a-z0-9_-]*$/u.test(value)
  ) {
    throw new Error("Workspace must be a lowercase slug up to 80 characters");
  }
  return value;
}
