import { Hono } from "hono";
import { z } from "zod";
import {
  currentPrincipal,
  requireHttpAccess,
  type HttpPrincipal,
  type StensiblyEnv,
} from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import { projectAttachmentLedger } from "./project-attachment-ledger.js";
import { compileProjectContract } from "./project-contract.js";

const route = "/projects/:project/attachment/verify-repository";
const requestSchema = z.object({
  repositoryFullName: z.string().min(3).max(512),
  expectedDefaultBranch: z.string().min(1).max(240),
}).strict();
const commitShaPattern = /^[a-f0-9]{40}$/u;
const sourceFingerprintPattern = /^sha256:[a-f0-9]{64}$/u;

interface RepositoryVerificationProvider {
  githubRepoHealth(input: {
    project: string;
    repository: string;
    actorId: string;
    clientId: string;
  }): Promise<unknown>;
  callGitHubDelegatedRead(input: {
    project: string;
    repository: string;
    tool: string;
    arguments: Record<string, unknown>;
    actorId: string;
    clientId: string;
    catalogueFingerprint: string;
  }): Promise<unknown>;
}

export function registerProjectAttachmentRepositoryVerificationApi(
  app: Hono<StensiblyEnv>,
  ledger: WorkLedger,
): void {
  app.post(route, async (context) => {
    const project = context.req.param("project");
    const denied = requireHttpAccess(context, "admin", project);
    if (denied) return denied;
    const principal = currentPrincipal(context);
    if (!principal) {
      return context.json({ error: "Authentication is required", code: "unauthorized" }, 401);
    }
    const attachments = projectAttachmentLedger(ledger);
    if (!attachments) {
      return context.json({
        error: "Project attachments are unavailable on this backend",
        code: "not_supported",
      }, 501);
    }
    const provider = repositoryVerificationProvider(ledger);
    if (!provider) {
      return context.json({
        error: "Guarded repository verification is unavailable on this backend",
        code: "not_supported",
      }, 501);
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "Request body must be valid JSON", code: "invalid_request" }, 400);
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({ error: "Repository verification request is invalid", code: "invalid_request" }, 400);
    }

    let attachment;
    try {
      attachment = await attachments.getProjectAttachment(project);
    } catch {
      return context.json({
        error: "Accepted project attachment could not be read",
        code: "verification_context_failed",
      }, 502);
    }
    if (!attachment) {
      return context.json({
        error: "An accepted project attachment is required before repository verification",
        code: "attachment_required",
      }, 409);
    }
    const repositoryFullName = exactRepository(parsed.data.repositoryFullName);
    if (!repositoryFullName || !attachment.snapshot.contract.repositories.includes(repositoryFullName)) {
      return context.json({
        error: "Repository verification target is outside the accepted attachment",
        code: "verification_target_mismatch",
      }, 409);
    }
    const expectedDefaultBranch = exactText(parsed.data.expectedDefaultBranch, 240);
    if (!expectedDefaultBranch) {
      return context.json({ error: "Repository verification request is invalid", code: "invalid_request" }, 400);
    }
    const sourcePath = attachment.snapshot.source.path;
    const expectedSourceFingerprint = attachment.snapshot.source.contentSha256;
    const expectedSnapshotSha256 = attachment.snapshot.snapshotSha256;
    if (!sourceFingerprintPattern.test(expectedSourceFingerprint)) {
      return context.json({
        error: "Accepted project attachment source metadata is incompatible",
        code: "verification_context_failed",
      }, 409);
    }

    const identity = {
      project,
      repository: repositoryFullName,
      actorId: principalIdentity(principal),
      clientId: "http:project-attachment-repository-verification",
    };
    try {
      const health = await provider.githubRepoHealth(identity);
      const admittedHealth = readRepositoryHealth(health, {
        project,
        repositoryFullName,
        attachmentId: attachment.id,
        attachmentSnapshotSha256: expectedSnapshotSha256,
        expectedDefaultBranch,
      });
      const delegated = await provider.callGitHubDelegatedRead({
        ...identity,
        tool: "fetch_file",
        arguments: {
          path: sourcePath,
          ref: admittedHealth.commitSha,
        },
        catalogueFingerprint: admittedHealth.catalogueFingerprint,
      });
      const file = readImmutableFileReceipt(delegated, {
        project,
        repositoryFullName,
        attachmentId: attachment.id,
        attachmentSnapshotSha256: expectedSnapshotSha256,
        sourcePath,
        commitSha: admittedHealth.commitSha,
      });
      const source = decodeUtf8Base64(file.contentBase64);
      let observedSnapshot;
      try {
        observedSnapshot = compileProjectContract(source, sourcePath);
      } catch {
        return context.json({
          error: "Immutable repository source does not compile to the accepted attachment",
          code: "repository_source_mismatch",
          verification: {
            version: 1,
            project,
            repositoryFullName,
            defaultBranch: admittedHealth.defaultBranch,
            commitSha: admittedHealth.commitSha,
            sourcePath,
            expectedSourceFingerprint,
            expectedSnapshotSha256,
            observedSourceFingerprint: null,
            observedSnapshotSha256: null,
            verified: false,
            authorizesMutation: false,
            containsSecrets: false,
          },
        }, 409);
      }
      const observedSourceFingerprint = observedSnapshot.source.contentSha256;
      const observedSnapshotSha256 = observedSnapshot.snapshotSha256;
      if (
        observedSourceFingerprint !== expectedSourceFingerprint
        || observedSnapshotSha256 !== expectedSnapshotSha256
      ) {
        return context.json({
          error: "Immutable repository source does not match the accepted attachment",
          code: "repository_source_mismatch",
          verification: {
            version: 1,
            project,
            repositoryFullName,
            defaultBranch: admittedHealth.defaultBranch,
            commitSha: admittedHealth.commitSha,
            sourcePath,
            expectedSourceFingerprint,
            expectedSnapshotSha256,
            observedSourceFingerprint,
            observedSnapshotSha256,
            verified: false,
            authorizesMutation: false,
            containsSecrets: false,
          },
        }, 409);
      }
      return context.json({
        verification: {
          version: 1,
          project,
          repositoryFullName,
          defaultBranch: admittedHealth.defaultBranch,
          commitSha: admittedHealth.commitSha,
          sourcePath,
          sourceContentSha256: observedSourceFingerprint,
          attachment: {
            id: attachment.id,
            snapshotSha256: observedSnapshotSha256,
          },
          steps: {
            repositoryMetadata: "get_repo",
            immutableFileRead: "fetch_file",
            immutableReadRef: "exact_commit_sha",
          },
          verified: true,
          authorizesMutation: false,
          containsSecrets: false,
        },
      });
    } catch {
      return context.json({
        error: "Guarded repository verification could not prove the accepted attachment",
        code: "repository_verification_failed",
      }, 502);
    }
  });
}

function repositoryVerificationProvider(ledger: WorkLedger): RepositoryVerificationProvider | null {
  const githubRepoHealth = Reflect.get(ledger as object, "githubRepoHealth") as unknown;
  const callGitHubDelegatedRead = Reflect.get(ledger as object, "callGitHubDelegatedRead") as unknown;
  if (typeof githubRepoHealth !== "function" || typeof callGitHubDelegatedRead !== "function") return null;
  return {
    githubRepoHealth: (input) => Reflect.apply(githubRepoHealth, ledger, [input]) as Promise<unknown>,
    callGitHubDelegatedRead: (input) => Reflect.apply(callGitHubDelegatedRead, ledger, [input]) as Promise<unknown>,
  };
}

function readRepositoryHealth(value: unknown, expected: {
  project: string;
  repositoryFullName: string;
  attachmentId: string;
  attachmentSnapshotSha256: string;
  expectedDefaultBranch: string;
}): { defaultBranch: string; commitSha: string; catalogueFingerprint: string } {
  const root = record(value);
  const attachment = record(root.attachment);
  const repository = record(root.repository);
  if (
    root.version !== 1
    || root.project !== expected.project
    || root.repositoryFullName !== expected.repositoryFullName
    || root.authorizesMutation !== false
    || attachment.id !== expected.attachmentId
    || attachment.snapshotSha256 !== expected.attachmentSnapshotSha256
  ) throw new TypeError("repository health mismatch");
  const defaultBranch = exactText(repository.defaultBranch, 240);
  if (!defaultBranch || defaultBranch !== expected.expectedDefaultBranch) {
    throw new TypeError("repository default branch mismatch");
  }
  const commitSha = exactCommitSha(repository.defaultBranchSha);
  const catalogueFingerprint = exactFingerprint(root.catalogueFingerprint);
  return { defaultBranch, commitSha, catalogueFingerprint };
}

function readImmutableFileReceipt(value: unknown, expected: {
  project: string;
  repositoryFullName: string;
  attachmentId: string;
  attachmentSnapshotSha256: string;
  sourcePath: string;
  commitSha: string;
}): { contentBase64: string } {
  const receipt = record(value);
  const result = record(receipt.result);
  if (
    receipt.version !== 1
    || receipt.project !== expected.project
    || receipt.repositoryFullName !== expected.repositoryFullName
    || receipt.tool !== "fetch_file"
    || receipt.attachmentId !== expected.attachmentId
    || receipt.attachmentSnapshotSha256 !== expected.attachmentSnapshotSha256
    || result.repositoryFullName !== expected.repositoryFullName
    || result.path !== expected.sourcePath
    || result.ref !== expected.commitSha
    || result.encoding !== "base64"
  ) throw new TypeError("immutable file receipt mismatch");
  if (typeof result.contentBase64 !== "string" || result.contentBase64.length > 200_000) {
    throw new TypeError("immutable file content is invalid");
  }
  return { contentBase64: result.contentBase64 };
}

function decodeUtf8Base64(value: string): string {
  const compact = value.replace(/\r?\n/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact)) {
    throw new TypeError("immutable file content is invalid");
  }
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function principalIdentity(principal: HttpPrincipal): string {
  return `${principal.kind === "account" ? "account" : "token"}:${principal.name}`;
}

function exactRepository(value: string): string | null {
  if (value !== value.trim() || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) return null;
  return value;
}

function exactText(value: unknown, maximum: number): string | null {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return null;
  return value;
}

function exactCommitSha(value: unknown): string {
  if (typeof value !== "string" || !commitShaPattern.test(value)) throw new TypeError("invalid commit SHA");
  return value;
}

function exactFingerprint(value: unknown): string {
  if (typeof value !== "string" || !sourceFingerprintPattern.test(value)) throw new TypeError("invalid fingerprint");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid record");
  return value as Record<string, unknown>;
}
