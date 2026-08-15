import type { AdmittedGitHubTerminalStatusObservation } from "./github-mail-bridge.js";
import {
  normalizeGitHubRepository,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import type { PreparedGitHubWebhookDelivery } from "./github-webhook-ingress.js";

const terminalEventTypes = [
  "check_run",
  "check_suite",
  "workflow_run",
  "deployment_status",
] as const;

type TerminalEventType = typeof terminalEventTypes[number];

type CheckConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "neutral"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale"
  | "startup_failure";

/**
 * Projects only terminal GitHub execution/deployment webhooks after the shared
 * ingress has verified HMAC-SHA256 over the original request bytes. Provider
 * payload prose stays transient; the returned envelope carries identities,
 * status, revision, and a semantic fingerprint only.
 */
export function mapGitHubMailTerminalWebhook(
  delivery: PreparedGitHubWebhookDelivery,
): AdmittedGitHubTerminalStatusObservation | null {
  if (
    delivery.signatureAlgorithm !== "hmac-sha256"
    || delivery.payloadAvailability !== "memory_only"
    || delivery.containsRawBody !== false
  ) {
    throw new RangeError("GitHub terminal mail projection requires verified webhook ingress");
  }
  if (!terminalEventTypes.includes(delivery.eventType as TerminalEventType)) {
    return null;
  }
  const eventType = delivery.eventType as TerminalEventType;
  const payload = record(delivery.payload, "GitHub terminal webhook payload");
  const repository = repositoryFullName(payload);

  const semantics = eventType === "check_run"
    ? mapCheckRun(payload)
    : eventType === "check_suite"
    ? mapCheckSuite(payload)
    : eventType === "workflow_run"
    ? mapWorkflowRun(payload)
    : mapDeploymentStatus(payload);
  if (!semantics) return null;

  const sourceTime = semantics.sourceTime ?? delivery.receivedAt;
  const fingerprintInput = {
    version: 1 as const,
    provider: "github" as const,
    sourceSchema: eventType,
    repository,
    pullRequestNumber: semantics.pullRequestNumber,
    revision: semantics.revision,
    providerObjectId: semantics.providerObjectId,
    conclusion: semantics.conclusion,
    sourceTime,
    containsRawContent: false as const,
  };
  return deepFreeze({
    ...fingerprintInput,
    observationId: `github-mail-terminal:${eventType}:${delivery.deliveryId}`,
    deliveryId: delivery.deliveryId,
    semanticFingerprint: sha256(stableJson(fingerprintInput)),
  });
}

interface TerminalSemantics {
  revision: string;
  pullRequestNumber: number | null;
  providerObjectId: string;
  conclusion: CheckConclusion;
  sourceTime: string | null;
}

function mapCheckRun(
  payload: Record<string, unknown>,
): TerminalSemantics | null {
  const value = record(payload.check_run, "GitHub check run");
  if (value.status !== "completed") return null;
  const conclusion = checkConclusion(value.conclusion, "GitHub check run conclusion");
  return {
    revision: revision(value.head_sha, "GitHub check run head revision"),
    pullRequestNumber: singlePullRequestNumber(value.pull_requests),
    providerObjectId: providerId(value.id, "GitHub check run ID"),
    conclusion,
    sourceTime: providerTime(value.completed_at ?? value.updated_at),
  };
}

function mapCheckSuite(
  payload: Record<string, unknown>,
): TerminalSemantics | null {
  const value = record(payload.check_suite, "GitHub check suite");
  if (value.status !== "completed") return null;
  const conclusion = checkConclusion(value.conclusion, "GitHub check suite conclusion");
  return {
    revision: revision(value.head_sha, "GitHub check suite head revision"),
    pullRequestNumber: singlePullRequestNumber(value.pull_requests),
    providerObjectId: providerId(value.id, "GitHub check suite ID"),
    conclusion,
    sourceTime: providerTime(value.updated_at ?? value.created_at),
  };
}

function mapWorkflowRun(
  payload: Record<string, unknown>,
): TerminalSemantics | null {
  const value = record(payload.workflow_run, "GitHub workflow run");
  if (value.status !== "completed") return null;
  const conclusion = checkConclusion(value.conclusion, "GitHub workflow run conclusion");
  return {
    revision: revision(value.head_sha, "GitHub workflow run head revision"),
    pullRequestNumber: singlePullRequestNumber(value.pull_requests),
    providerObjectId: providerId(value.id, "GitHub workflow run ID"),
    conclusion,
    sourceTime: providerTime(value.updated_at ?? value.created_at),
  };
}

function mapDeploymentStatus(
  payload: Record<string, unknown>,
): TerminalSemantics | null {
  const status = record(payload.deployment_status, "GitHub deployment status");
  const deployment = record(payload.deployment, "GitHub deployment");
  const state = text(status.state, "GitHub deployment status state");
  let conclusion: CheckConclusion;
  if (state === "success") {
    conclusion = "success";
  } else if (state === "failure" || state === "error") {
    conclusion = "failure";
  } else if (state === "inactive") {
    conclusion = "neutral";
  } else if (
    state === "pending"
    || state === "queued"
    || state === "in_progress"
  ) {
    return null;
  } else {
    throw new RangeError("GitHub deployment status state is unsupported");
  }
  return {
    revision: revision(deployment.sha, "GitHub deployment revision"),
    pullRequestNumber: null,
    providerObjectId: providerId(status.id, "GitHub deployment status ID"),
    conclusion,
    sourceTime: providerTime(status.updated_at ?? status.created_at),
  };
}

function repositoryFullName(payload: Record<string, unknown>): string {
  const repository = record(payload.repository, "GitHub webhook repository");
  return normalizeGitHubRepository(
    text(repository.full_name, "GitHub webhook repository full name"),
  );
}

function singlePullRequestNumber(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const numbers = new Set<number>();
  for (const entry of value) {
    const pullRequest = record(entry, "GitHub terminal pull request reference");
    const number = pullRequest.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
      throw new RangeError("GitHub terminal pull request number is invalid");
    }
    numbers.add(number);
    if (numbers.size > 1) return null;
  }
  return numbers.size === 1 ? [...numbers][0]! : null;
}

function checkConclusion(value: unknown, label: string): CheckConclusion {
  if (
    value === "success"
    || value === "failure"
    || value === "cancelled"
    || value === "neutral"
    || value === "skipped"
    || value === "timed_out"
    || value === "action_required"
    || value === "stale"
    || value === "startup_failure"
  ) {
    return value;
  }
  throw new RangeError(`${label} is invalid`);
}

function revision(value: unknown, label: string): string {
  const normalized = text(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new RangeError(`${label} must be a full Git revision`);
  }
  return normalized;
}

function providerId(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]{0,39}$/u.test(value)) {
    return value;
  }
  throw new RangeError(`${label} is invalid`);
}

function providerTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = text(value, "GitHub terminal source time");
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("GitHub terminal source time is invalid");
  }
  return date.toISOString();
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)
    || value.length > 512
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
