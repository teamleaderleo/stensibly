import type { GitHubDelegatedReadAdapter } from "../../src/github-delegated-read.ts";

export interface FakeGitHubDelegatedReadCall {
  tool: string;
  arguments: Record<string, unknown>;
  repositoryFullName: string;
  connectionId: string;
  installationId: string;
  credentialRef: string;
  catalogueFingerprint: string;
}

export interface FakeGitHubDelegatedReadResponse {
  result: unknown;
  providerRequestId?: string;
}

interface QueuedOutcome {
  response?: FakeGitHubDelegatedReadResponse;
  error?: Error;
}

/**
 * Deterministic provider-neutral adapter for the #585 delegated-read conformance lane.
 *
 * Calls are snapshotted before the configured outcome is returned. Unconfigured tools
 * fail closed, which prevents a test from accidentally claiming support for a broader
 * upstream GitHub MCP surface than it explicitly exercises.
 */
export class FakeGitHubDelegatedReadAdapter implements GitHubDelegatedReadAdapter {
  readonly calls: FakeGitHubDelegatedReadCall[] = [];
  readonly #outcomes = new Map<string, QueuedOutcome[]>();

  enqueueResponse(tool: string, response: FakeGitHubDelegatedReadResponse): void {
    this.#enqueue(tool, { response: snapshot(response) });
  }

  enqueueError(tool: string, error: Error): void {
    this.#enqueue(tool, { error });
  }

  async callReadTool(input: FakeGitHubDelegatedReadCall): Promise<FakeGitHubDelegatedReadResponse> {
    this.calls.push(Object.freeze(snapshot(input)));
    const queue = this.#outcomes.get(input.tool);
    const outcome = queue?.shift();
    if (!outcome) {
      throw new Error(`No fake GitHub delegated-read outcome configured for ${input.tool}`);
    }
    if (outcome.error) throw outcome.error;
    return snapshot(outcome.response ?? { result: null });
  }

  #enqueue(tool: string, outcome: QueuedOutcome): void {
    const normalized = tool.trim().toLocaleLowerCase("en-US");
    if (!normalized) throw new RangeError("Fake GitHub delegated-read tool is required");
    const queue = this.#outcomes.get(normalized) ?? [];
    queue.push(outcome);
    this.#outcomes.set(normalized, queue);
  }
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}
