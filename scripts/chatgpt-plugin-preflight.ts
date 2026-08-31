import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  compileMcpCapabilitySubmissionAnnotations,
  mcpCapabilityPolicyRegistry,
  requireMcpCapabilityPolicy,
} from "../src/mcp-capability-policy.js";
import { createChatGptMcpServer } from "../src/chatgpt-mcp.js";
import { compileMcpPublishedContract } from "../src/mcp-published-contract.js";
import { SqliteWorkLedger } from "../src/sqlite-ledger.js";
import { StensiblyStore } from "../src/store.js";

const SNAPSHOT_PATH = new URL("../docs/chatgpt-app-actions.json", import.meta.url);
const SUBMISSION_PATH = new URL("../chatgpt-app-submission.json", import.meta.url);

const annotationKeys = [
  "readOnlyHint",
  "destructiveHint",
  "openWorldHint",
] as const;

interface PublicationSnapshot {
  snapshotVersion: number;
  toolContractVersion: number;
  reviewedMetadataVersion: number;
  toolCount: number;
  tools: string[];
  toolContractFingerprint: string;
  serverInstructionsFingerprint: string;
  reviewedMetadataFingerprint: string;
}

interface SubmissionArtifact {
  tools: Record<string, {
    annotations?: Record<string, unknown>;
  }>;
  test_cases: unknown[];
  negative_test_cases: unknown[];
}

export interface ChatGptPluginPreflightReport {
  version: 1;
  status: "ready_for_portal_scan" | "blocked";
  snapshotVersion: number;
  profile: "published_default";
  toolCount: number;
  toolContractVersion: number;
  reviewedMetadataVersion: number;
  outputSchemaCount: number;
  genericOutputSchemaCount: number;
  titleCount: number;
  positiveTestCaseCount: number;
  negativeTestCaseCount: number;
  toolContractFingerprint: string;
  serverInstructionsFingerprint: string;
  reviewedMetadataFingerprint: string;
  blockers: string[];
  warnings: string[];
}

export async function runChatGptPluginPreflight(): Promise<ChatGptPluginPreflightReport> {
  const snapshot = readJson<PublicationSnapshot>(SNAPSHOT_PATH);
  const submission = readJson<SubmissionArtifact>(SUBMISSION_PATH);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const store = new StensiblyStore(":memory:");
  const server = createChatGptMcpServer(new SqliteWorkLedger(store));
  const client = new Client(
    { name: "chatgpt-plugin-preflight", version: "1" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const instructions = client.getInstructions() ?? "";
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    const snapshotToolNames = [...snapshot.tools].sort();
    const submissionToolNames = Object.keys(submission.tools).sort();
    const outputSchemaCount = listed.tools.filter(
      (tool) => tool.outputSchema !== undefined,
    ).length;
    const genericOutputSchemaCount = listed.tools.filter(
      (tool) => isGenericJsonEnvelopeSchema(tool.outputSchema),
    ).length;
    const titleCount = listed.tools.filter(
      (tool) => typeof tool.title === "string" && tool.title.trim().length > 0,
    ).length;

    if (listed.tools.length !== snapshot.toolCount) {
      blockers.push(
        `Live tool count ${listed.tools.length} does not match snapshot ${snapshot.toolCount}.`,
      );
    }
    if (!sameStrings(toolNames, snapshotToolNames)) {
      blockers.push("Live tool names do not match the checked-in publication snapshot.");
    }
    if (!sameStrings(submissionToolNames, snapshotToolNames)) {
      blockers.push("Submission tool names do not match the checked-in publication snapshot.");
    }

    for (const tool of listed.tools) {
      const expected = compileMcpCapabilitySubmissionAnnotations(
        requireMcpCapabilityPolicy(tool.name),
      );
      const actual = tool.annotations ?? {};
      const submitted = submission.tools[tool.name]?.annotations ?? {};
      for (const key of annotationKeys) {
        if (actual[key] !== expected[key]) {
          blockers.push(`Live annotation mismatch: ${tool.name}.${key}.`);
        }
        if (submitted[key] !== expected[key]) {
          blockers.push(`Submission annotation mismatch: ${tool.name}.${key}.`);
        }
      }
    }

    const hiddenInstructionReferences = mcpCapabilityPolicyRegistry.policies
      .filter((policy) => policy.defaultExposure !== "core")
      .map((policy) => policy.toolName)
      .filter((toolName) => instructions.includes(`\`${toolName}\``));
    if (hiddenInstructionReferences.length) {
      blockers.push(
        `Public instructions reference hidden tools: ${hiddenInstructionReferences.join(", ")}.`,
      );
    }

    const contract = compileMcpPublishedContract(
      listed.tools.map((tool) => ({
        name: tool.name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.annotations === undefined
          ? {}
          : { annotations: tool.annotations as Record<string, unknown> }),
        inputSchema: tool.inputSchema as Record<string, unknown>,
        ...(tool.outputSchema === undefined
          ? {}
          : { outputSchema: tool.outputSchema as Record<string, unknown> }),
        ...(tool.execution === undefined
          ? {}
          : { execution: tool.execution as Record<string, unknown> }),
        ...(tool._meta === undefined
          ? {}
          : { _meta: tool._meta as Record<string, unknown> }),
      })),
      mcpCapabilityPolicyRegistry,
      "published_default",
      instructions,
    );
    if (contract.publishedManifest.schemaVersion !== snapshot.toolContractVersion) {
      blockers.push("Live tool-contract version does not match the checked-in snapshot.");
    }
    if (contract.version !== snapshot.reviewedMetadataVersion) {
      blockers.push("Live reviewed-metadata version does not match the checked-in snapshot.");
    }
    compareFingerprint(
      blockers,
      "tool contract",
      contract.publishedManifest.digest,
      snapshot.toolContractFingerprint,
    );
    compareFingerprint(
      blockers,
      "server instructions",
      contract.serverInstructionsFingerprint,
      snapshot.serverInstructionsFingerprint,
    );
    compareFingerprint(
      blockers,
      "reviewed metadata",
      contract.publishedContractFingerprint,
      snapshot.reviewedMetadataFingerprint,
    );

    if (submission.test_cases.length !== 5) {
      blockers.push(
        `Submission has ${submission.test_cases.length} positive test cases; expected 5.`,
      );
    }
    if (submission.negative_test_cases.length !== 3) {
      blockers.push(
        `Submission has ${submission.negative_test_cases.length} negative test cases; expected 3.`,
      );
    }
    if (outputSchemaCount < listed.tools.length) {
      warnings.push(
        `${listed.tools.length - outputSchemaCount} public tools omit outputSchema; add structured result contracts before first review for stronger host validation.`,
      );
    }
    if (genericOutputSchemaCount > 0) {
      warnings.push(
        `${genericOutputSchemaCount} public tools use the generic JSON result envelope; replace it with precise per-tool schemas for stronger field-level validation.`,
      );
    }
    if (titleCount < listed.tools.length) {
      warnings.push(
        `${listed.tools.length - titleCount} public tools omit a human-readable title; add titles before first review to improve tool selection and reviewability.`,
      );
    }

    return {
      version: 1,
      status: blockers.length ? "blocked" : "ready_for_portal_scan",
      snapshotVersion: snapshot.snapshotVersion,
      profile: "published_default",
      toolCount: listed.tools.length,
      toolContractVersion: contract.publishedManifest.schemaVersion,
      reviewedMetadataVersion: contract.version,
      outputSchemaCount,
      genericOutputSchemaCount,
      titleCount,
      positiveTestCaseCount: submission.test_cases.length,
      negativeTestCaseCount: submission.negative_test_cases.length,
      toolContractFingerprint: contract.publishedManifest.digest,
      serverInstructionsFingerprint: contract.serverInstructionsFingerprint,
      reviewedMetadataFingerprint: contract.publishedContractFingerprint,
      blockers,
      warnings,
    };
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
}

function compareFingerprint(
  blockers: string[],
  label: string,
  actual: string,
  expected: string,
): void {
  if (actual !== expected) {
    blockers.push(`Live ${label} fingerprint does not match the checked-in snapshot.`);
  }
}

function readJson<T>(path: URL): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isGenericJsonEnvelopeSchema(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "object" || value.additionalProperties !== false) {
    return false;
  }
  if (!Array.isArray(value.required) || value.required.length !== 1 || value.required[0] !== "data") {
    return false;
  }
  if (!isRecord(value.properties) || !isRecord(value.properties.data)) return false;
  return Object.keys(value.properties.data).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const report = await runChatGptPluginPreflight();
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "blocked") process.exitCode = 1;
}
