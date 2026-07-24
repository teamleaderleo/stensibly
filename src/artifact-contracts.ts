import { z } from "zod";
import { actorSchema } from "./schemas.js";

export const artifactKinds = [
  "file",
  "url",
  "commit",
  "issue",
  "document",
  "image",
  "log",
  "dataset",
  "other",
] as const;

export const attachArtifactSchema = z.object({
  actor: actorSchema,
  kind: z.enum(artifactKinds),
  label: z.string().trim().min(1).max(240),
  uri: z.string().trim().min(1).max(4096),
  mimeType: z.string().trim().min(1).max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ArtifactKind = (typeof artifactKinds)[number];

export interface Artifact {
  id: string;
  itemId: string;
  actorId: string;
  kind: ArtifactKind;
  label: string;
  uri: string;
  mimeType: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
