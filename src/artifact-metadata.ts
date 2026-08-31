import { z } from "zod";

const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_NODES = 500;
const MAX_METADATA_CHARACTERS = 16_000;
const sensitiveKeyPattern = /^(?:api[-_]?key|authorization|credential|credentials|password|private[-_]?key|secret|token)$/i;
const sensitiveValuePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i,
  /\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-|stn\.tok_)[A-Za-z0-9._-]{8,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
];

const artifactMetadataValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(artifactMetadataValueSchema).max(50),
  z.record(z.string().trim().min(1).max(80), artifactMetadataValueSchema),
]));

export const artifactMetadataSchema = z
  .record(z.string().trim().min(1).max(80), artifactMetadataValueSchema)
  .superRefine((metadata, context) => {
    let nodes = 0;
    inspectMetadata(metadata, [], 0, context, () => {
      nodes += 1;
      return nodes <= MAX_METADATA_NODES;
    });
    if (JSON.stringify(metadata).length > MAX_METADATA_CHARACTERS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Artifact metadata must not exceed ${MAX_METADATA_CHARACTERS} characters`,
      });
    }
  });

function inspectMetadata(
  value: unknown,
  path: PropertyKey[],
  depth: number,
  context: z.RefinementCtx,
  admitNode: () => boolean,
): void {
  if (!admitNode()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Artifact metadata must not exceed ${MAX_METADATA_NODES} values`,
      path,
    });
    return;
  }
  if (depth > MAX_METADATA_DEPTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Artifact metadata must not exceed depth ${MAX_METADATA_DEPTH}`,
      path,
    });
    return;
  }
  if (typeof value === "string") {
    if (sensitiveValuePatterns.some((pattern) => pattern.test(value))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Artifact metadata must not contain credential-shaped values",
        path,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectMetadata(
      entry,
      [...path, index],
      depth + 1,
      context,
      admitNode,
    ));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const entryPath = [...path, key];
      if (sensitiveKeyPattern.test(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Artifact metadata must not contain credential fields",
          path: entryPath,
        });
      }
      inspectMetadata(entry, entryPath, depth + 1, context, admitNode);
    }
  }
}
