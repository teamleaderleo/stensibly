import { z } from "zod";
import type { Artifact } from "./artifact-contracts.js";
import { sha256, stableJson } from "./canonical-json.js";

export const LOCAL_OVERLAY_ARTIFACT_V1 = 1 as const;

const repositorySchema = z.string().trim().min(3).max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  .transform((value) => value.toLowerCase());
const gitBlobShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const bytesSchema = z.number().int().min(1).max(1_048_576);

const transportMetadataSchema = z.object({
  transport: z.literal("github_blob"),
  repository: repositorySchema,
  gitBlobSha: gitBlobShaSchema,
  sha256: sha256Schema,
  bytes: bytesSchema,
  format: z.literal("unified_diff_utf8"),
}).strict();

export interface ExpectedLocalOverlayV1 {
  readonly format: "unified_diff_utf8";
  readonly artifactRef: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface LocalOverlayArtifactV1 {
  readonly version: typeof LOCAL_OVERLAY_ARTIFACT_V1;
  readonly transport: "github_blob";
  readonly artifactId: string;
  readonly repository: string;
  readonly gitBlobSha: string;
  readonly apiUrl: string;
  readonly format: "unified_diff_utf8";
  readonly sha256: string;
  readonly bytes: number;
  readonly grantsAuthority: false;
  readonly authorizesExecution: false;
  readonly fingerprint: string;
}

/**
 * Reconcile one Stensibly artifact pointer with the exact overlay identity already
 * fingerprinted into `local_action_intent/v1`.
 *
 * This compiler performs no provider read and grants no execution authority. It
 * only admits a canonical GitHub Git-blob URL whose repository/blob/digest/size
 * agree across the artifact, its closed metadata, and the expected local action.
 */
export function compileLocalOverlayArtifactV1(input: {
  readonly artifact: Artifact;
  readonly expected: ExpectedLocalOverlayV1;
  readonly expectedRepository: string;
}): Readonly<LocalOverlayArtifactV1> {
  if (input.artifact.id !== input.expected.artifactRef) {
    throw new RangeError("Local overlay artifact reference changed");
  }
  if (input.artifact.kind !== "file") {
    throw new TypeError("Local overlay artifact must be a file reference");
  }
  if (input.artifact.mimeType !== "text/x-diff") {
    throw new TypeError("Local overlay artifact MIME type must be text/x-diff");
  }
  const expectedRepository = repositorySchema.parse(input.expectedRepository);
  const expected = z.object({
    format: z.literal("unified_diff_utf8"),
    artifactRef: z.string().trim().min(1).max(240),
    sha256: sha256Schema,
    bytes: bytesSchema,
  }).strict().parse(input.expected);
  const metadata = transportMetadataSchema.parse(input.artifact.metadata);
  const uri = parseCanonicalGitHubBlobUrl(input.artifact.uri);

  if (metadata.repository !== expectedRepository || uri.repository !== expectedRepository) {
    throw new RangeError("Local overlay repository changed");
  }
  if (metadata.gitBlobSha !== uri.gitBlobSha) {
    throw new RangeError("Local overlay Git blob identity changed");
  }
  if (metadata.sha256 !== expected.sha256 || metadata.bytes !== expected.bytes) {
    throw new RangeError("Local overlay content identity changed");
  }
  if (metadata.format !== expected.format) {
    throw new RangeError("Local overlay format changed");
  }

  const body = {
    version: LOCAL_OVERLAY_ARTIFACT_V1,
    transport: "github_blob" as const,
    artifactId: input.artifact.id,
    repository: expectedRepository,
    gitBlobSha: uri.gitBlobSha,
    apiUrl: uri.apiUrl,
    format: metadata.format,
    sha256: metadata.sha256,
    bytes: metadata.bytes,
    grantsAuthority: false as const,
    authorizesExecution: false as const,
  };
  return Object.freeze({ ...body, fingerprint: sha256(stableJson(body)) });
}

function parseCanonicalGitHubBlobUrl(value: string): {
  readonly repository: string;
  readonly gitBlobSha: string;
  readonly apiUrl: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Local overlay artifact URI must be a canonical GitHub API URL");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "api.github.com"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new TypeError("Local overlay artifact URI must be a canonical GitHub API URL");
  }
  const match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/git\/blobs\/([a-f0-9]{40})$/u.exec(url.pathname);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new TypeError("Local overlay artifact URI must name one exact GitHub blob");
  }
  const repository = repositorySchema.parse(`${match[1]}/${match[2]}`);
  const gitBlobSha = gitBlobShaSchema.parse(match[3]);
  return {
    repository,
    gitBlobSha,
    apiUrl: `https://api.github.com/repos/${repository}/git/blobs/${gitBlobSha}`,
  };
}
