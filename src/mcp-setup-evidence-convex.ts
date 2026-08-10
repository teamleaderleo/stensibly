import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  admitMcpSetupEvidence,
  type McpSetupEvidence,
  type McpSetupEvidenceReader,
} from "./mcp-setup-evidence.js";

export interface ConvexMcpSetupEvidenceServiceOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace: string;
}

const recordConnectionRef = makeFunctionReference<"mutation">(
  "mcpSetupEvidence:recordConnection",
);
const getEvidenceRef = makeFunctionReference<"query">(
  "mcpSetupEvidence:getEvidence",
);

export class ConvexMcpSetupEvidenceService implements McpSetupEvidenceReader {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexMcpSetupEvidenceServiceOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = exactWorkspace(options.workspace);
  }

  async recordSetupConnection(input: {
    accountId: string;
    clientId: string;
    resource: string;
  }): Promise<void> {
    try {
      await this.client.mutation(
        recordConnectionRef,
        this.args(input),
      );
    } catch {
      throw new Error("MCP setup evidence storage failed");
    }
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
