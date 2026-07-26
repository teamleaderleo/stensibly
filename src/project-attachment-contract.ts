export const PROJECT_ATTACHMENT_FILENAME = "STENSIBLY.md";
export const PROJECT_ATTACHMENT_VERSION = 1 as const;

export const PROJECT_ATTACHMENT_DISCOVERY = Object.freeze({
  explicitPathPrecedesDefault: true,
  defaultPath: PROJECT_ATTACHMENT_FILENAME,
  recursiveSearch: false,
  similarlyNamedFallback: false,
});

export const PROJECT_ATTACHMENT_ACTIONS = [
  "inspect", "propose", "edit_files", "run_checks", "create_branch",
  "push_branch", "create_draft_pr", "open_issue", "comment", "request_review",
  "merge", "deploy", "external_message", "provider_change",
  "broad_permission_change", "credential_change", "destructive_cleanup", "spend",
] as const;
export type ProjectAttachmentAction = typeof PROJECT_ATTACHMENT_ACTIONS[number];

export const REQUIRED_APPROVAL_ACTIONS = [
  "merge", "deploy", "external_message", "provider_change",
  "broad_permission_change", "credential_change", "destructive_cleanup", "spend",
] as const satisfies readonly ProjectAttachmentAction[];

const TOP_KEYS = [
  "version", "project", "repositories", "runner_profiles", "concurrency",
  "autonomous_actions", "approval_required", "checks",
] as const;
const LIST_KEYS = new Set([
  "repositories", "runner_profiles", "autonomous_actions", "approval_required", "checks",
]);
const ACTIONS = new Set<string>(PROJECT_ATTACHMENT_ACTIONS);
const BODY_HEADINGS = [
  "Goal", "Boundaries", "Evidence and handoff expectations", "Escalation",
] as const;
const MAX_BYTES = 128_000;
const MAX_LIST = 32;

export interface ProjectAttachmentSourceMetadata {
  path: string;
  repository?: string;
  revision?: string;
}

export interface ProjectAttachmentBody {
  goal: string;
  boundaries: string;
  evidenceAndHandoff: string;
  escalation: string;
}

export interface CanonicalProjectAttachmentContract {
  version: typeof PROJECT_ATTACHMENT_VERSION;
  project: string;
  repositories: string[];
  runnerProfiles: string[];
  concurrency: { project: number; global: number };
  autonomousActions: ProjectAttachmentAction[];
  approvalRequired: ProjectAttachmentAction[];
  /** Ordered opaque verification-profile identifiers; never executable command text. */
  checks: string[];
  body: ProjectAttachmentBody;
}

export interface ParsedProjectAttachmentContract {
  contract: CanonicalProjectAttachmentContract;
  source: ProjectAttachmentSourceMetadata;
  digestInput: string;
}

export interface ProjectAttachmentValidationError {
  code:
    | "document_too_large" | "control_character" | "secret_shaped_value"
    | "missing_front_matter" | "malformed_front_matter" | "duplicate_key"
    | "unknown_key" | "noncanonical_key" | "missing_field" | "invalid_value"
    | "duplicate_value" | "unsupported_version" | "missing_section"
    | "duplicate_section" | "unknown_section" | "section_order" | "section_too_large";
  path: string;
  message: string;
}

export type ProjectAttachmentParseResult =
  | { ok: true; value: ParsedProjectAttachmentContract }
  | { ok: false; errors: ProjectAttachmentValidationError[] };

interface RawFrontMatter {
  version?: string;
  project?: string;
  repositories?: string[];
  runner_profiles?: string[];
  concurrency?: Record<string, string>;
  autonomous_actions?: string[];
  approval_required?: string[];
  checks?: string[];
}

export interface ProjectAttachmentSetChange {
  added: string[];
  removed: string[];
  orderChanged: boolean;
}

export interface ProjectAttachmentContractDiff {
  changed: boolean;
  versionIncompatible: boolean;
  widensPermissions: boolean;
  narrowsPermissions: boolean;
  wideningReasons: string[];
  narrowingReasons: string[];
  repositories: ProjectAttachmentSetChange;
  runnerProfiles: ProjectAttachmentSetChange;
  autonomousActions: ProjectAttachmentSetChange;
  approvalRequired: ProjectAttachmentSetChange;
  checks: ProjectAttachmentSetChange;
  concurrency: {
    project: "increased" | "decreased" | "unchanged";
    global: "increased" | "decreased" | "unchanged";
  };
  bodyChanged: boolean;
  bodyOnly: boolean;
}

export type ComparableProjectAttachmentContract =
  Omit<CanonicalProjectAttachmentContract, "version"> & { version: number };

type Errors = ProjectAttachmentValidationError[];

export function parseProjectAttachmentContract(
  content: string,
  sourceInput: ProjectAttachmentSourceMetadata = { path: PROJECT_ATTACHMENT_FILENAME },
): ProjectAttachmentParseResult {
  const errors: Errors = [];
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  if (new TextEncoder().encode(normalized).byteLength > MAX_BYTES) {
    error(errors, "document_too_large", "$", `${PROJECT_ATTACHMENT_FILENAME} exceeds 128 KB`);
  }
  if (/\t|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    error(errors, "control_character", "$", "Tabs and control characters are forbidden");
  }
  if (secretShaped(normalized)) {
    error(errors, "secret_shaped_value", "$", "Credential-shaped content is forbidden");
  }
  if (errors.length) return failed(errors);

  const split = splitFrontMatter(normalized, errors);
  if (!split) return failed(errors);
  const raw = parseFrontMatter(split.frontMatter, errors);
  const body = parseBody(split.body, errors);
  const source = normalizeSource(sourceInput, errors);
  if (!raw || !body || !source || errors.length) return failed(errors);
  const contract = canonicalize(raw, body, errors);
  if (!contract || errors.length) return failed(errors);

  return {
    ok: true,
    value: { contract, source, digestInput: projectAttachmentDigestInput(contract) },
  };
}

export function assertProjectAttachmentContract(
  content: string,
  source?: ProjectAttachmentSourceMetadata,
): ParsedProjectAttachmentContract {
  const result = parseProjectAttachmentContract(content, source);
  if (result.ok) return result.value;
  throw new Error(
    `Invalid ${PROJECT_ATTACHMENT_FILENAME}: ${result.errors
      .map((item) => `${item.path}: ${item.message}`)
      .join("; ")}`,
  );
}

export function projectAttachmentDigestInput(
  contract: ComparableProjectAttachmentContract,
): string {
  return JSON.stringify({
    version: contract.version,
    project: contract.project,
    repositories: [...contract.repositories],
    runnerProfiles: [...contract.runnerProfiles],
    concurrency: {
      project: contract.concurrency.project,
      global: contract.concurrency.global,
    },
    autonomousActions: [...contract.autonomousActions],
    approvalRequired: [...contract.approvalRequired],
    checks: [...contract.checks],
    body: {
      goal: contract.body.goal,
      boundaries: contract.body.boundaries,
      evidenceAndHandoff: contract.body.evidenceAndHandoff,
      escalation: contract.body.escalation,
    },
  });
}

export function compareProjectAttachmentContracts(
  previous: ComparableProjectAttachmentContract,
  proposed: ComparableProjectAttachmentContract,
): ProjectAttachmentContractDiff {
  const repositories = setChange(previous.repositories, proposed.repositories);
  const runnerProfiles = setChange(previous.runnerProfiles, proposed.runnerProfiles);
  const autonomousActions = setChange(previous.autonomousActions, proposed.autonomousActions);
  const approvalRequired = setChange(previous.approvalRequired, proposed.approvalRequired);
  const checks = setChange(previous.checks, proposed.checks, true);
  const projectConcurrency = numberChange(previous.concurrency.project, proposed.concurrency.project);
  const globalConcurrency = numberChange(previous.concurrency.global, proposed.concurrency.global);
  const versionIncompatible = previous.version !== proposed.version;
  const projectChanged = previous.project !== proposed.project;
  const bodyChanged = JSON.stringify(previous.body) !== JSON.stringify(proposed.body);

  const wideningReasons = [
    ...repositories.added.map((value) => `repository added: ${value}`),
    ...runnerProfiles.added.map((value) => `runner profile added: ${value}`),
    ...autonomousActions.added.map((value) => `autonomous action added: ${value}`),
    ...approvalRequired.removed.map((value) => `approval requirement removed: ${value}`),
    ...checks.removed.map((value) => `verification profile removed: ${value}`),
    ...(checks.orderChanged ? ["verification profile order changed"] : []),
    ...(projectConcurrency === "increased" ? ["project concurrency increased"] : []),
    ...(globalConcurrency === "increased" ? ["global concurrency increased"] : []),
    ...(projectChanged ? ["project identity changed"] : []),
    ...(versionIncompatible ? ["contract version changed"] : []),
  ];
  const narrowingReasons = [
    ...repositories.removed.map((value) => `repository removed: ${value}`),
    ...runnerProfiles.removed.map((value) => `runner profile removed: ${value}`),
    ...autonomousActions.removed.map((value) => `autonomous action removed: ${value}`),
    ...approvalRequired.added.map((value) => `approval requirement added: ${value}`),
    ...checks.added.map((value) => `verification profile added: ${value}`),
    ...(projectConcurrency === "decreased" ? ["project concurrency decreased"] : []),
    ...(globalConcurrency === "decreased" ? ["global concurrency decreased"] : []),
  ];
  const policyChanged = versionIncompatible || projectChanged ||
    changed(repositories) || changed(runnerProfiles) || changed(autonomousActions) ||
    changed(approvalRequired) || changed(checks) || checks.orderChanged ||
    projectConcurrency !== "unchanged" || globalConcurrency !== "unchanged";

  return {
    changed: policyChanged || bodyChanged,
    versionIncompatible,
    widensPermissions: wideningReasons.length > 0,
    narrowsPermissions: narrowingReasons.length > 0,
    wideningReasons,
    narrowingReasons,
    repositories,
    runnerProfiles,
    autonomousActions,
    approvalRequired,
    checks,
    concurrency: { project: projectConcurrency, global: globalConcurrency },
    bodyChanged,
    bodyOnly: bodyChanged && !policyChanged,
  };
}

function splitFrontMatter(
  content: string,
  errors: Errors,
): { frontMatter: string[]; body: string } | null {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    error(errors, "missing_front_matter", "$", "The first line must be ---");
    return null;
  }
  const closing = lines.indexOf("---", 1);
  if (closing < 0) {
    error(errors, "malformed_front_matter", "$", "Front matter has no closing --- delimiter");
    return null;
  }
  return {
    frontMatter: lines.slice(1, closing),
    body: lines.slice(closing + 1).join("\n"),
  };
}

function parseFrontMatter(lines: string[], errors: Errors): RawFrontMatter | null {
  const result: RawFrontMatter = {};
  const seen = new Set<string>();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      error(errors, "malformed_front_matter", `front_matter.line_${index + 2}`, "Unexpected indentation");
      index += 1;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!match) {
      error(errors, "malformed_front_matter", `front_matter.line_${index + 2}`, "Expected key: value syntax");
      index += 1;
      continue;
    }

    const rawKey = match[1] ?? "";
    const key = rawKey.toLowerCase().replace(/-/g, "_");
    if (seen.has(key)) {
      error(errors, "duplicate_key", `front_matter.${key}`, "Duplicate key after normalisation");
    }
    seen.add(key);
    if (!TOP_KEYS.includes(key as typeof TOP_KEYS[number])) {
      error(errors, "unknown_key", `front_matter.${key}`, "Unknown top-level policy key");
    }
    if (rawKey !== key) {
      error(errors, "noncanonical_key", `front_matter.${key}`, `Use the canonical key ${key}`);
    }
    const inline = (match[2] ?? "").trim();

    if (key === "concurrency") {
      if (inline) {
        error(errors, "invalid_value", "front_matter.concurrency", "Concurrency must be a two-key block");
      }
      const parsed = parseConcurrency(lines, index + 1, errors);
      result.concurrency = parsed.value;
      index = parsed.next;
      continue;
    }
    if (LIST_KEYS.has(key)) {
      if (inline) {
        error(errors, "invalid_value", `front_matter.${key}`, "Lists must use one indented - item per line");
      }
      const parsed = parseList(lines, index + 1, key, errors);
      assignList(result, key, parsed.values);
      index = parsed.next;
      continue;
    }
    if (!inline) {
      error(errors, "missing_field", `front_matter.${key}`, "A scalar value is required");
    } else if (key === "version" || key === "project") {
      result[key] = scalar(inline, `front_matter.${key}`, errors);
    }
    index += 1;
  }

  return errors.some((item) => item.code === "malformed_front_matter") ? null : result;
}

function parseConcurrency(
  lines: string[],
  start: number,
  errors: Errors,
): { value: Record<string, string>; next: number } {
  const value: Record<string, string> = {};
  const seen = new Set<string>();
  let index = start;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (!line.startsWith("  ")) break;
    const match = /^  ([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/.exec(line);
    if (!match) {
      error(errors, "malformed_front_matter", `front_matter.concurrency.line_${index + 2}`, "Expected two-space key: value syntax");
      index += 1;
      continue;
    }
    const rawKey = match[1] ?? "";
    const key = rawKey.toLowerCase().replace(/-/g, "_");
    if (seen.has(key)) {
      error(errors, "duplicate_key", `front_matter.concurrency.${key}`, "Duplicate concurrency key");
    }
    seen.add(key);
    if (rawKey !== key) {
      error(errors, "noncanonical_key", `front_matter.concurrency.${key}`, `Use the canonical key ${key}`);
    }
    if (key !== "project" && key !== "global") {
      error(errors, "unknown_key", `front_matter.concurrency.${key}`, "Unknown concurrency key");
    } else {
      value[key] = scalar(match[2] ?? "", `front_matter.concurrency.${key}`, errors);
    }
    index += 1;
  }

  return { value, next: index };
}

function parseList(
  lines: string[],
  start: number,
  key: string,
  errors: Errors,
): { values: string[]; next: number } {
  const values: string[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (!line.startsWith("  ")) break;
    const match = /^  -\s+(.+)$/.exec(line);
    if (!match) {
      error(errors, "malformed_front_matter", `front_matter.${key}.line_${index + 2}`, "Expected two-space - item syntax");
      index += 1;
      continue;
    }
    values.push(scalar(match[1] ?? "", `front_matter.${key}[${values.length}]`, errors));
    index += 1;
  }

  return { values, next: index };
}

function scalar(raw: string, path: string, errors: Errors): string {
  const value = raw.trim();
  if (value.startsWith('"') || value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") {
        if (/[\u0000-\u001F\u007F]/.test(parsed)) {
          error(errors, "control_character", path, "Decoded values cannot contain tabs or control characters");
          return "";
        }
        if (secretShaped(parsed)) {
          error(errors, "secret_shaped_value", path, "Credential-shaped decoded values are forbidden");
          return "";
        }
        return parsed;
      }
    } catch {
      // Error reported below.
    }
    error(errors, "invalid_value", path, "Double-quoted values must use valid JSON string escaping");
    return "";
  }
  if (/^(?:[&*!>|\[\]{}]|'.*')/.test(value) || /\s+#/.test(value)) {
    error(errors, "invalid_value", path, "YAML aliases, tags, block scalars, flow values, single quotes, and comments are unsupported");
    return "";
  }
  return value;
}

function parseBody(input: string, errors: Errors): ProjectAttachmentBody | null {
  const lines = input.split("\n");
  const found: Array<{ heading: string; index: number }> = [];
  let fence: { character: "`" | "~"; length: number } | null = null;

  for (const [index, line] of lines.entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const run = delimiter?.[1] ?? "";
    if (fence) {
      if (
        run[0] === fence.character &&
        run.length >= fence.length &&
        (delimiter?.[2] ?? "").trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (run) {
      fence = { character: run[0] as "`" | "~", length: run.length };
      continue;
    }
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const heading = match[1] ?? "";
    if (!BODY_HEADINGS.includes(heading as typeof BODY_HEADINGS[number])) {
      error(errors, "unknown_section", `body.line_${index + 1}`, `Unknown level-two section: ${heading}`);
    }
    found.push({ heading, index });
  }

  for (const heading of BODY_HEADINGS) {
    const count = found.filter((entry) => entry.heading === heading).length;
    if (count === 0) {
      error(errors, "missing_section", `body.${bodyKey(heading)}`, `Missing ${heading} section`);
    }
    if (count > 1) {
      error(errors, "duplicate_section", `body.${bodyKey(heading)}`, `More than one ${heading} section`);
    }
  }
  const recognized = found.filter((entry) =>
    BODY_HEADINGS.includes(entry.heading as typeof BODY_HEADINGS[number])
  );
  if (
    recognized.length === BODY_HEADINGS.length &&
    recognized.some((entry, index) => entry.heading !== BODY_HEADINGS[index])
  ) {
    error(errors, "section_order", "body", `Sections must appear in this order: ${BODY_HEADINGS.join(", ")}`);
  }
  if (errors.some((item) => [
    "missing_section", "duplicate_section", "unknown_section", "section_order",
  ].includes(item.code))) {
    return null;
  }

  const sections: Partial<ProjectAttachmentBody> = {};
  for (const [position, entry] of recognized.entries()) {
    const next = recognized[position + 1]?.index ?? lines.length;
    const text = lines
      .slice(entry.index + 1, next)
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .trim();
    const key = bodyKey(entry.heading as typeof BODY_HEADINGS[number]);
    if (!text) {
      error(errors, "invalid_value", `body.${key}`, `${entry.heading} must not be empty`);
    }
    if (text.length > 10_000) {
      error(errors, "section_too_large", `body.${key}`, `${entry.heading} exceeds 10,000 characters`);
    }
    sections[key] = text;
  }
  if (errors.length) return null;

  return {
    goal: sections.goal ?? "",
    boundaries: sections.boundaries ?? "",
    evidenceAndHandoff: sections.evidenceAndHandoff ?? "",
    escalation: sections.escalation ?? "",
  };
}

function canonicalize(
  raw: RawFrontMatter,
  body: ProjectAttachmentBody,
  errors: Errors,
): CanonicalProjectAttachmentContract | null {
  for (const key of TOP_KEYS) {
    if (raw[key] === undefined) {
      error(errors, "missing_field", `front_matter.${key}`, `Missing required field ${key}`);
    }
  }
  if (errors.length) return null;

  const version = integer(raw.version ?? "", 1, 999, "front_matter.version", errors);
  if (version !== null && version !== PROJECT_ATTACHMENT_VERSION) {
    error(errors, "unsupported_version", "front_matter.version", "Only version 1 is supported");
  }
  const project = simple(raw.project ?? "", 80)?.toLowerCase();
  if (!project || !/^[a-z0-9][a-z0-9-]*$/.test(project)) {
    error(errors, "invalid_value", "front_matter.project", "Project must be a lowercase slug using letters, digits, and hyphens");
  }

  const repositories = list(
    raw.repositories ?? [], repository, "front_matter.repositories", 1, MAX_LIST, errors,
  );
  const runnerProfiles = list(
    raw.runner_profiles ?? [], namedIdentifier, "front_matter.runner_profiles", 1, MAX_LIST, errors,
  );
  const autonomousActions = actionList(
    raw.autonomous_actions ?? [], "front_matter.autonomous_actions", errors,
  );
  const approvalRequired = actionList(
    raw.approval_required ?? [], "front_matter.approval_required", errors,
  );
  const checks = list(
    raw.checks ?? [], checkProfile, "front_matter.checks", 1, 24, errors, false,
  );
  const projectConcurrency = integer(
    raw.concurrency?.project ?? "", 1, 16, "front_matter.concurrency.project", errors,
  );
  const globalConcurrency = integer(
    raw.concurrency?.global ?? "", 1, 64, "front_matter.concurrency.global", errors,
  );
  if (
    projectConcurrency !== null &&
    globalConcurrency !== null &&
    projectConcurrency > globalConcurrency
  ) {
    error(errors, "invalid_value", "front_matter.concurrency.project", "Project concurrency cannot exceed global concurrency");
  }

  const approvalSet = new Set(approvalRequired);
  for (const action of REQUIRED_APPROVAL_ACTIONS) {
    if (!approvalSet.has(action)) {
      error(errors, "invalid_value", "front_matter.approval_required", `Version 1 requires approval for ${action}`);
    }
  }
  const overlap = autonomousActions.filter((action) => approvalSet.has(action));
  if (overlap.length) {
    error(errors, "invalid_value", "front_matter.autonomous_actions", `Actions cannot be both autonomous and approval-required: ${overlap.join(", ")}`);
  }

  if (
    errors.length ||
    version === null ||
    !project ||
    projectConcurrency === null ||
    globalConcurrency === null
  ) {
    return null;
  }

  return {
    version: PROJECT_ATTACHMENT_VERSION,
    project,
    repositories,
    runnerProfiles,
    concurrency: { project: projectConcurrency, global: globalConcurrency },
    autonomousActions,
    approvalRequired,
    checks,
    body,
  };
}

function normalizeSource(
  input: ProjectAttachmentSourceMetadata,
  errors: Errors,
): ProjectAttachmentSourceMetadata | null {
  const path = sourcePath(input.path);
  const repo = input.repository === undefined ? undefined : repository(input.repository);
  const revision = input.revision === undefined ? undefined : simple(input.revision, 200);

  if (!path || secretShaped(input.path)) {
    error(
      errors,
      "invalid_value",
      "source.path",
      "Source path must be a bounded credential-free repository-relative path without traversal",
    );
  }
  if (input.repository !== undefined && !repo) {
    error(errors, "invalid_value", "source.repository", "Source repository must use owner/repository");
  }
  if (input.revision !== undefined && (!revision || secretShaped(revision))) {
    error(errors, "invalid_value", "source.revision", "Source revision must be bounded credential-free text");
  }
  if (errors.length || !path) return null;

  return {
    path,
    ...(repo ? { repository: repo } : {}),
    ...(revision ? { revision } : {}),
  };
}

function actionList(
  values: string[],
  path: string,
  errors: Errors,
): ProjectAttachmentAction[] {
  return list(values, (value) => {
    const normalized = simple(value, 64)?.toLowerCase().replace(/-/g, "_");
    return normalized && ACTIONS.has(normalized)
      ? normalized as ProjectAttachmentAction
      : null;
  }, path, 0, MAX_LIST, errors);
}

function sourcePath(value: string): string | null {
  if (!value || value !== value.trim() || value.length > 4096) return null;
  if (/[\u0000-\u001F\u007F]/.test(value) || value.includes("\\")) return null;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return value;
}

function repository(value: string): string | null {
  const normalized = simple(value, 160)?.toLowerCase();
  if (!normalized || normalized.endsWith(".git")) return null;
  const parts = normalized.split("/");
  if (parts.length !== 2) return null;
  const segment = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
  return parts[0] && parts[1] && segment.test(parts[0]) && segment.test(parts[1])
    ? `${parts[0]}/${parts[1]}`
    : null;
}

function namedIdentifier(value: string): string | null {
  const normalized = simple(value, 64)?.toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9._-]*$/.test(normalized)
    ? normalized
    : null;
}

function checkProfile(value: string): string | null {
  const normalized = simple(value, 64)?.toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9._-]*$/.test(normalized)
    ? normalized
    : null;
}

function simple(value: string, maximum: number): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized &&
      normalized.length <= maximum &&
      !/[\u0000-\u001F\u007F]/.test(normalized)
    ? normalized
    : null;
}

function integer(
  value: string,
  minimum: number,
  maximum: number,
  path: string,
  errors: Errors,
): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    error(errors, "invalid_value", path, "Expected a base-10 integer");
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    error(errors, "invalid_value", path, `Value must be between ${minimum} and ${maximum}`);
    return null;
  }
  return parsed;
}

function list<T extends string>(
  values: string[],
  normalize: (value: string) => T | null,
  path: string,
  minimum: number,
  maximum: number,
  errors: Errors,
  sort = true,
): T[] {
  if (values.length < minimum || values.length > maximum) {
    error(errors, "invalid_value", path, `List must contain between ${minimum} and ${maximum} items`);
  }
  const output: T[] = [];
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const normalized = normalize(value);
    if (!normalized) {
      error(errors, "invalid_value", `${path}[${index}]`, "Invalid or unsafe value");
    } else if (seen.has(normalized)) {
      error(errors, "duplicate_value", `${path}[${index}]`, "Duplicate value after normalisation");
    } else {
      seen.add(normalized);
      output.push(normalized);
    }
  });
  return sort ? output.sort(compareCodeUnits) : output;
}

function secretShaped(value: string): boolean {
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_]{12,}\b/,
    /\bsk-[A-Za-z0-9_-]{12,}\b/,
    /\bstn\.tok_[A-Za-z0-9._-]{8,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i,
    /\b(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/i,
  ].some((pattern) => pattern.test(value));
}

function assignList(result: RawFrontMatter, key: string, values: string[]): void {
  if (
    key === "repositories" ||
    key === "runner_profiles" ||
    key === "autonomous_actions" ||
    key === "approval_required" ||
    key === "checks"
  ) {
    result[key] = values;
  }
}

function bodyKey(
  heading: typeof BODY_HEADINGS[number],
): keyof ProjectAttachmentBody {
  if (heading === "Goal") return "goal";
  if (heading === "Boundaries") return "boundaries";
  if (heading === "Evidence and handoff expectations") return "evidenceAndHandoff";
  return "escalation";
}

function setChange(
  previous: readonly string[],
  proposed: readonly string[],
  trackOrder = false,
): ProjectAttachmentSetChange {
  const before = new Set(previous);
  const after = new Set(proposed);
  return {
    added: [...after].filter((value) => !before.has(value)).sort(compareCodeUnits),
    removed: [...before].filter((value) => !after.has(value)).sort(compareCodeUnits),
    orderChanged: trackOrder && sharedOrderChanged(previous, proposed),
  };
}

function sharedOrderChanged(
  previous: readonly string[],
  proposed: readonly string[],
): boolean {
  const proposedSet = new Set(proposed);
  const previousSet = new Set(previous);
  const previousShared = previous.filter((value) => proposedSet.has(value));
  const proposedShared = proposed.filter((value) => previousSet.has(value));
  return previousShared.length > 1 &&
    previousShared.some((value, index) => value !== proposedShared[index]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function numberChange(
  previous: number,
  proposed: number,
): "increased" | "decreased" | "unchanged" {
  return proposed > previous ? "increased" : proposed < previous ? "decreased" : "unchanged";
}

function changed(change: ProjectAttachmentSetChange): boolean {
  return change.added.length > 0 || change.removed.length > 0;
}

function error(
  errors: Errors,
  code: ProjectAttachmentValidationError["code"],
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

function failed(errors: Errors): ProjectAttachmentParseResult {
  return {
    ok: false,
    errors: [...errors].sort((left, right) =>
      compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code)
    ),
  };
}
