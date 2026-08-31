import { z } from "zod";
import { sha256, stableJson } from "./canonical-json.js";

export const LOCAL_ACTION_INTENT_V1 = 1 as const;
export const localActionClasses = ["repo_query", "verify", "command", "develop"] as const;
export const localLatencyClasses = ["interactive", "normal", "background", "measurement"] as const;
export const localInterferenceClasses = ["coexist", "yieldable", "quiet_required"] as const;
export const localNetworkClasses = ["none", "project_default"] as const;
export const localEnvironmentProfiles = ["minimal", "project_default"] as const;

const unsafeText = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const credentialText = /(?:stn\.tok_|github_pat_|gh[pousr]_|sk-(?:proj-)?|Bearer\s+)[A-Za-z0-9._~+\/-]+/iu;
const safeText = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !unsafeText.test(value), "contains unsafe text")
  .refine((value) => !credentialText.test(value), "must not contain credential-shaped text");
const literalText = (max: number) => z.string().max(max)
  .refine((value) => !unsafeText.test(value), "contains unsafe text")
  .refine((value) => !credentialText.test(value), "must not contain credential-shaped text");
const identifier = safeText(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u);
const profileId = safeText(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const gitOid = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const repository = z.string().trim().min(3).max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  .transform((value) => value.toLowerCase());
const timestamp = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const overlaySchema = z.object({
  format: z.literal("unified_diff_utf8"),
  artifactRef: identifier,
  sha256: digest,
  bytes: z.number().int().min(1).max(1_048_576),
}).strict();

const sourceSchema = z.object({
  repository,
  baseCommit: gitOid,
  baseTree: gitOid,
  workspaceClass: z.enum(["resident_exact", "task_private"]),
  workspaceGeneration: identifier.nullable(),
  overlay: overlaySchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.overlay && value.workspaceClass !== "task_private") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["overlay"], message: "overlay requires a task_private workspace" });
  }
});

const relativePath = literalText(512).transform((value, context) => {
  if (value.length === 0 || value.includes("\\")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "relative cwd is invalid and must use / separators" });
    return z.NEVER;
  }
  const segments = value.split("/");
  if (
    value.startsWith("/")
    || value.endsWith("/")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "relative cwd is invalid" });
    return z.NEVER;
  }
  return value;
});

const posixShellExecutables = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
  "fish",
]);
const powerShellExecutables = new Set(["pwsh", "powershell", "powershell.exe"]);
const cmdExecutables = new Set(["cmd", "cmd.exe"]);

function containsInlineShellCommand(argv: readonly string[]): boolean {
  const executable = argv[0]?.toLowerCase() ?? "";
  const args = argv.slice(1);
  if (posixShellExecutables.has(executable)) {
    return args.some((argument) =>
      argument === "--command"
      || argument === "--init-command"
      || /^-[A-Za-z]*c[A-Za-z]*$/u.test(argument)
      || (executable === "fish" && argument === "-C")
    );
  }
  if (powerShellExecutables.has(executable)) {
    return args.some((argument) =>
      ["-command", "-commandwithargs", "-encodedcommand"].includes(argument.toLowerCase())
    );
  }
  if (cmdExecutables.has(executable)) {
    return args.some((argument) => ["/c", "/k"].includes(argument.toLowerCase()));
  }
  return false;
}

const argvSchema = z.array(literalText(2_048)).min(1).max(64).superRefine((argv, context) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(argv[0] ?? "")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [0], message: "executable must be a bare executable name without a path" });
  }
  if (containsInlineShellCommand(argv)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inline shell command strings are not permitted; use argv or a reviewed repository script/profile",
    });
  }
  const bytes = argv.reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 0);
  if (bytes > 16 * 1_024) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "argv exceeds the aggregate byte limit" });
  }
});

const commandSchema = z.object({
  argv: argvSchema,
  cwd: z.object({
    kind: z.enum(["workspace_root", "repository_subdir"]),
    relativePath: relativePath.nullable(),
  }).strict().superRefine((value, context) => {
    if (value.kind === "workspace_root" && value.relativePath !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["relativePath"], message: "workspace_root cwd cannot carry a relative path" });
    }
    if (value.kind === "repository_subdir" && value.relativePath === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["relativePath"], message: "repository_subdir cwd requires a relative path" });
    }
  }),
  environmentProfile: z.enum(localEnvironmentProfiles),
}).strict();

const inputSchema = z.object({
  version: z.literal(LOCAL_ACTION_INTENT_V1),
  project: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/u),
  itemId: identifier,
  expectedClaimGeneration: z.number().int().min(0),
  actionClass: z.enum(localActionClasses),
  source: sourceSchema,
  command: commandSchema.nullable(),
  profileId: profileId.nullable(),
  latencyClass: z.enum(localLatencyClasses),
  interferenceClass: z.enum(localInterferenceClasses),
  resourceProfile: profileId,
  networkClass: z.enum(localNetworkClasses),
  deadlineSeconds: z.number().int().min(1).max(3_600),
  outputLimitBytes: z.number().int().min(1_024).max(1_048_576),
  createdAt: timestamp,
  expiresAt: timestamp,
}).strict().superRefine((value, context) => {
  const lifetime = Date.parse(value.expiresAt) - Date.parse(value.createdAt);
  if (lifetime <= 0 || lifetime > 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "intent lifetime must be >0 and <=24 hours" });
  }
  if (value.actionClass === "command") {
    if (!value.command) context.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "command action requires a command" });
    if (value.profileId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["profileId"], message: "command action cannot carry a profile ID" });
  } else {
    if (value.command) context.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: `${value.actionClass} action cannot carry a command` });
    if (!value.profileId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["profileId"], message: `${value.actionClass} action requires a profile ID` });
  }
  if (value.actionClass === "develop" && value.source.workspaceClass !== "task_private") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["source", "workspaceClass"], message: "develop action requires a task_private workspace" });
  }
});

export type LocalActionIntentInputV1 = z.input<typeof inputSchema>;
export type LocalActionIntentV1 = Readonly<z.output<typeof inputSchema> & {
  grantsAuthority: false;
  authorizesExecution: false;
  fingerprint: string;
  idempotencyKey: string;
}>;

/**
 * Compile a connected-agent request for local engineering into a deterministic,
 * authority-free intent. A later dispatch/admission boundary must re-read current
 * work, node, source, resource, profile, and principal capability before execution.
 *
 * `source.overlay` is only an immutable artifact reference + digest. This lets a
 * network-isolated ChatGPT sandbox author a patch and hand the bytes to an owned
 * node through Stensibly without publishing an intermediate GitHub commit.
 */
export function compileLocalActionIntentV1(value: unknown): LocalActionIntentV1 {
  const parsed = inputSchema.parse(value);
  const body = {
    ...parsed,
    grantsAuthority: false as const,
    authorizesExecution: false as const,
  };
  const fingerprint = sha256(stableJson(body));
  return deepFreeze({
    ...body,
    fingerprint,
    idempotencyKey: `local-action:${fingerprint.slice("sha256:".length)}`,
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
