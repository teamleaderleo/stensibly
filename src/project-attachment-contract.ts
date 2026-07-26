export const PROJECT_ATTACHMENT_FILENAME = "STENSIBLY.md";
export const PROJECT_ATTACHMENT_VERSION = 1 as const;

export const PROJECT_ATTACHMENT_DISCOVERY = Object.freeze({
  explicitPathPrecedesDefault: true,
  defaultPath: PROJECT_ATTACHMENT_FILENAME,
  recursiveSearch: false,
  similarlyNamedFallback: false,
});

export const PROJECT_ATTACHMENT_ACTIONS = [
  "inspect",
  "propose",
  "edit_files",
  "run_checks",
  "create_branch",
  "push_branch",
  "create_draft_pr",
  "open_issue",
  "comment",
  "request_review",
  "merge",
  "deploy",
  "external_message",
  "provider_change",
  "broad_permission_change",
  "credential_change",
  "destructive_cleanup",
  "spend",
] as const;

export type ProjectAttachmentAction = typeof PROJECT_ATTACHMENT_ACTIONS[number];

export const REQUIRED_APPROVAL_ACTIONS = [
  "merge",
  "deploy",
  "external_message",
  "provider_change",
  "broad_permission_change",
] as const satisfies readonly ProjectAttachmentAction[];

const TOP_LEVEL_KEYS = [
  "version",
  "project",
  "repositories",
  "runner_profiles",
  "concurrency",
  "autonomous_actions",
  "approval_required",
  "checks",
] as const;

const LIST_KEYS = new Set([
  "repositories",
  "runner_profiles",
  "autonomous_actions",
  "approval_required",
  "checks",
]);

const BODY_HEADINGS = [
  "Goal",
  "Boundaries",
  "Evidence and handoff expectations",
  "Escalation",
] as const;

const ACTION_SET = new Set<string>(PROJECT_ATTACHMENT_ACTIONS);
const TOP_LEVEL_KEY_SET = new Set<string>(TOP_LEVEL_KEYS);
const MAX_DOCUMENT_BYTES = 128_000;
const MAX_BODY_SECTION_LENGTH = 10_000;
const MAX_LIST_ITEMS = 32;
const MAX_CHECKS = 24;
const MAX_COMMAND_LENGTH = 240;

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
  concurrency: {
    project: number;
    global: number;
  };
  autonomousActions: ProjectAttachmentAction[];
  approvalRequired: ProjectAttachmentAction[];
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
    | "document_too_large"
    | "control_character"
    | "secret_shaped_value"
    | "missing_front_matter"
    | "malformed_front_matter"
    | "duplicate_key"
    | "unknown_key"
    | "noncanonical_key"
    | "missing_field"
    | "invalid_value"
    | "duplicate_value"
    | "unsupported_version"
    | "missing_section"
    | "duplicate_section"
    | "unknown_section"
    | "section_order"
    | "section_too_large";
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

export type ComparableProjectAttachmentContract = Omit<
  CanonicalProjectAttachmentContract,
  "version"
> & { version: number };

export function parseProjectAttachmentContract(
  content: string,
  sourceInput: ProjectAttachmentSourceMetadata = { path: PROJECT_ATTACHMENT_FILENAME },
): ProjectAttachmentParseResult {
  const errors: ProjectAttachmentValidationError[] = [];
  const normalized = normalizeDocument(content);

  if (new TextEncoder().encode(normalized).byteLength > MAX_DOCUMENT_BYTES) {
    addError(errors, "document_too_large", "$", `${PROJECT_ATTACHMENT_FILENAME} exceeds 128 KB`);
  }
  if (/\t/.test(normalized) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    addError(errors, "control_character", "$", "Tabs and control characters are forbidden");
  }
  if (containsSecretShapedValue(normalized)) {
    addError(errors, "secret_shaped_value", "$", "Credential-shaped content is forbidden");
  }
  if (errors.length > 0) return failure(errors);

  const split = splitFrontMatter(normalized, errors);
  if (!split) return failure(errors);

  const raw = parseRestrictedFrontMatter(split.frontMatterLines, errors);
  const body = parseBody(split.body, errors);
  const source = normalizeSource(sourceInput, errors);
  if (!raw || !body || !source || errors.length > 0) return failure(errors);

  const contract = validateAndCanonicalize(raw, body, errors);
  if (!contract || errors.length > 0) return failure(errors);

  return {
    ok: true,
    value: {
      contract,
      source,
      digestInput: projectAttachmentDigestInput(contract),
    },
  };
}

export function assertProjectAttachmentContract(
  content: string,
  source?: ProjectAttachmentSourceMetadata,
): ParsedProjectAttachmentContract {
  const result = parseProjectAttachmentContract(content, source);
  if (result.ok) return result.value;
  const summary = result.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
  throw new Error(`Invalid ${PROJECT_ATTACHMENT_FILENAME}: ${summary}`);
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
  const repositories = compareSets(previous.repositories, proposed.repositories);
  const runnerProfiles = compareSets(previous.runnerProfiles, proposed.runnerProfiles);
  const autonomousActions = compareSets(previous.autonomousActions, proposed.autonomousActions);
  const approvalRequired = compareSets(previous.approvalRequired, proposed.approvalRequired);
  const checks = compareSets(previous.checks, proposed.checks, true);
  const projectConcurrency = compareNumber(previous.concurrency.project, proposed.concurrency.project);
  const globalConcurrency = compareNumber(previous.concurrency.global, proposed.concurrency.global);
  const versionIncompatible = previous.version !== proposed.version;
  const bodyChanged = JSON.stringify(previous.body) !== JSON.stringify(proposed.body);
  const projectChanged = previous.project !== proposed.project;

  const wideningReasons = [
    ...repositories.added.map((value) => `repository added: ${value}`),
    ...runnerProfiles.added.map((value) => `runner profile added: ${value}`),
    ...autonomousActions.added.map((value) => `autonomous action added: ${value}`),
    ...approvalRequired.removed.map((value) => `approval requirement removed: ${value}`),
    ...checks.removed.map((value) => `verification command removed: ${value}`),
    ...(checks.orderChanged ? ["verification command order changed"] : []),
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
    ...checks.added.map((value) => `verification command added: ${value}`),
    ...(projectConcurrency === "decreased" ? ["project concurrency decreased"] : []),
    ...(globalConcurrency === "decreased" ? ["global concurrency decreased"] : []),
  ];

  const policyChanged = versionIncompatible || projectChanged ||
    hasSetChange(repositories) || hasSetChange(runnerProfiles) ||
    hasSetChange(autonomousActions) || hasSetChange(approvalRequired) ||
    hasSetChange(checks) || checks.orderChanged ||
    projectConcurrency !== "unchanged" || globalConcurrency !== "unchanged";
  const changed = policyChanged || bodyChanged;

  return {
    changed,
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
    concurrency: {
      project: projectConcurrency,
      global: globalConcurrency,
    },
    bodyChanged,
    bodyOnly: bodyChanged && !policyChanged,
  };
}

function normalizeDocument(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function splitFrontMatter(
  content: string,
  errors: ProjectAttachmentValidationError[],
): { frontMatterLines: string[]; body: string } | null {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    addError(errors, "missing_front_matter", "$", "The first line must be ---");
    return null;
  }
  const closing = lines.indexOf("---", 1);
  if (closing < 0) {
    addError(errors, "malformed_front_matter", "$", "Front matter has no closing --- delimiter");
    return null;
  }
  if (lines.slice(closing + 1).some((line) => line === "---")) {
    addError(errors, "malformed_front_matter", "$", "Only one front matter block is allowed");
    return null;
  }
  return {
    frontMatterLines: lines.slice(1, closing),
    body: lines.slice(closing + 1).join("\n"),
  };
}

function parseRestrictedFrontMatter(
  lines: string[],
  errors: ProjectAttachmentValidationError[],
): RawFrontMatter | null {
  const result: RawFrontMatter = {};
  const seen = new Map<string, number>();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      addError(errors, "malformed_front_matter", `front_matter.line_${index + 2}`, "Unexpected indentation");
      index += 1;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!match) {
      addError(errors, "malformed_front_matter", `front_matter.line_${index + 2}`, "Expected key: value syntax");
      index += 1;
      continue;
    }
    const rawKey = match[1] ?? "";
    const key = normalizeKey(rawKey);
    if (seen.has(key)) {
      addError(errors, "duplicate_key", `front_matter.${key}`, "Duplicate key after normalisation");
    } else {
      seen.set(key, index + 2);
    }
    if (!TOP_LEVEL_KEY_SET.has(key)) {
      addError(errors, "unknown_key", `front_matter.${key}`, "Unknown top-level policy key");
    }
    if (rawKey !== key) {
      addError(errors, "noncanonical_key", `front_matter.${key}`, `Use the canonical key ${key}`);
    }

    const inline = (match[2] ?? "").trim();
    if (key === "concurrency") {
      if (inline !== "") {
        addError(errors, "invalid_value", "front_matter.concurrency", "Concurrency must be a two-key block");
      }
      const parsed = parseConcurrencyBlock(lines, index + 1, errors);
      if (parsed.value) result.concurrency = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (LIST_KEYS.has(key)) {
      if (inline !== "") {
        addError(errors, "invalid_value", `front_matter.${key}`, "Lists must use one indented - item per line");
      }
      const parsed = parseListBlock(lines, index + 1, key, errors);
      setRawList(result, key, parsed.values);
      index = parsed.nextIndex;
      continue;
    }
    if (inline === "") {
      addError(errors, "missing_field", `front_matter.${key}`, "A scalar value is required");
    } else if (key === "version" || key === "project") {
      result[key] = decodeScalar(inline, `front_matter.${key}`, errors);
    }
    index += 1;
  }

  return errors.some((error) => error.code === "malformed_front_matter") ? null : result;
}

function parseConcurrencyBlock(
  lines: string[],
  start: number,
  errors: ProjectAttachmentValidationError[],
): { value: Record<string, string> | null; nextIndex: number } {
  const value: Record<string, string> = {};
  const seen = new Set<string>();
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (!line.startsWith("  ")) break;
    const match = /^  ([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/.exec(line);
    if (!match) {
      addError(errors, "malformed_front_matter", `front_matter.concurrency.line_${index + 2}`, "Expected two-space key: value syntax");
      index += 1;
      continue;
    }
    const rawKey = match[1] ?? "";
    const key = normalizeKey(rawKey);
    if (seen.has(key)) addError(errors, "duplicate_key", `front_matter.concurrency.${key}`, "Duplicate concurrency key");
    seen.add(key);
    if (rawKey !== key) addError(errors, "noncanonical_key", `front_matter.concurrency.${key}`, `Use the canonical key ${key}`);
    if (key !== "project" && key !== "global") {
      addError(errors, "unknown_key", `front_matter.concurrency.${key}`, "Unknown concurrency key");
    } else {
      value[key] = decodeScalar(match[2] ?? "", `front_matter.concurrency.${key}`, errors);
    }
    index += 1;
  }
  return { value, nextIndex: index };
}

function parseListBlock(
  lines: string[],
  start: number,
  key: string,
  errors: ProjectAttachmentValidationError[],
): { values: string[]; nextIndex: number } {
  const values: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (!line.startsWith("  ")) break;
    const match = /^  -\s+(.+)$/.exec(line);
    if (!match) {
      addError(errors, "malformed_front_matter", `front_matter.${key}.line_${index + 2}`, "Expected two-space - item syntax");
      index += 1;
      continue;
    }
    values.push(decodeScalar(match[1] ?? "", `front_matter.${key}[${values.length}]`, errors));
    index += 1;
  }
  return { values, nextIndex: index };
}

function decodeScalar(
  raw: string,
  path: string,
  errors: ProjectAttachmentValidationError[],
): string {
  const value = raw.trim();
  if (value.startsWith("\"") || value.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      addError(errors, "invalid_value", path, "Double-quoted values must use valid JSON string escaping");
      return "";
    }
  }
  if (/^(?:[&*!>|\[\]{}]|'.*')/.test(value) || /\s+#/.test(value)) {
    addError(errors, "invalid_value", path, "YAML aliases, tags, block scalars, flow values, single quotes, and comments are unsupported");
    return "";
  }
  return value;
}

function parseBody(
  bodyInput: string,
  errors: ProjectAttachmentValidationError[],
): ProjectAttachmentBody | null {
  const lines = bodyInput.split("\n");
  const found: { heading: string; index: number }[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const heading = match[1] ?? "";
    if (!BODY_HEADINGS.includes(heading as typeof BODY_HEADINGS[number])) {
      addError(errors, "unknown_section", `body.line_${index + 1}`, `Unknown level-two section: ${heading}`);
    }
    found.push({ heading, index });
  }

  for (const heading of BODY_HEADINGS) {
    const matches = found.filter((entry) => entry.heading === heading);
    if (matches.length === 0) addError(errors, "missing_section", `body.${bodyKey(heading)}`, `Missing ${heading} section`);
    if (matches.length > 1) addError(errors, "duplicate_section", `body.${bodyKey(heading)}`, `More than one ${heading} section`);
  }
  const recognised = found.filter((entry) => BODY_HEADINGS.includes(entry.heading as typeof BODY_HEADINGS[number]));
  const order = recognised.map((entry) => entry.heading);
  if (order.length === BODY_HEADINGS.length && order.some((heading, index) => heading !== BODY_HEADINGS[index])) {
    addError(errors, "section_order", "body", `Sections must appear in this order: ${BODY_HEADINGS.join(", ")}`);
  }
  if (errors.some((error) => error.code === "missing_section" || error.code === "duplicate_section" || error.code === "unknown_section" || error.code === "section_order")) {
    return null;
  }

  const sections = {} as Record<string, string>;
  for (const [position, entry] of recognised.entries()) {
    const next = recognised[position + 1]?.index ?? lines.length;
    const text = normalizeBodyText(lines.slice(entry.index + 1, next).join("\n"));
    const key = bodyKey(entry.heading as typeof BODY_HEADINGS[number]);
    if (text.length === 0) addError(errors, "invalid_value", `body.${key}`, `${entry.heading} must not be empty`);
    if (text.length > MAX_BODY_SECTION_LENGTH) addError(errors, "section_too_large", `body.${key}`, `${entry.heading} exceeds 10,000 characters`);
    sections[key] = text;
  }
  if (errors.length > 0) return null;
  return {
    goal: sections.goal ?? "",
    boundaries: sections.boundaries ?? "",
    evidenceAndHandoff: sections.evidenceAndHandoff ?? "",
    escalation: sections.escalation ?? "",
  };
}

function normalizeSource(
  input: ProjectAttachmentSourceMetadata,
  errors: ProjectAttachmentValidationError[],
): ProjectAttachmentSourceMetadata | null {
  const path = normalizeSimpleText(input.path, 4096);
  if (!path || containsSecretShapedValue(path)) {
    addError(errors, "invalid_value", "source.path", "Source path must be bounded credential-free text");
  }
  const repository = input.repository === undefined ? undefined : normalizeRepository(input.repository);
  if (input.repository !== undefined && !repository) {
    addError(errors, "invalid_value", "source.repository", "Source repository must use owner/repository");
  }
  const revision = input.revision === undefined ? undefined : normalizeSimpleText(input.revision, 200);
  if (input.revision !== undefined && (!revision || containsSecretShapedValue(revision))) {
    addError(errors, "invalid_value", "source.revision", "Source revision must be bounded credential-free text");
  }
  if (errors.length > 0 || !path) return null;
  return {
    path,
    ...(repository ? { repository } : {}),
    ...(revision ? { revision } : {}),
  };
}

function validateAndCanonicalize(
  raw: RawFrontMatter,
  body: ProjectAttachmentBody,
  errors: ProjectAttachmentValidationError[],
): CanonicalProjectAttachmentContract | null {
  for (const key of TOP_LEVEL_KEYS) {
    if (raw[key] === undefined) addError(errors, "missing_field", `front_matter.${key}`, `Missing required field ${key}`);
  }
  if (errors.length > 0) return null;

  const version = parseInteger(raw.version ?? "", 1, 999, "front_matter.version", errors);
  if (version !== null && version !== PROJECT_ATTACHMENT_VERSION) {
    addError(errors, "unsupported_version", "front_matter.version", `Only version ${PROJECT_ATTACHMENT_VERSION} is supported`);
  }
  const project = normalizeIdentifier(raw.project ?? "", 80);
  if (!project || !/^[a-z0-9][a-z0-9-]*$/.test(project)) {
    addError(errors, "invalid_value", "front_matter.project", "Project must be a lowercase slug using letters, digits, and hyphens");
  }

  const repositories = normalizeList(raw.repositories ?? [], normalizeRepository, "front_matter.repositories", 1, MAX_LIST_ITEMS, errors);
  const runnerProfiles = normalizeList(raw.runner_profiles ?? [], (value) => normalizeNamedIdentifier(value, 64), "front_matter.runner_profiles", 1, MAX_LIST_ITEMS, errors);
  const autonomousActions = normalizeActionList(raw.autonomous_actions ?? [], "front_matter.autonomous_actions", errors);
  const approvalRequired = normalizeActionList(raw.approval_required ?? [], "front_matter.approval_required", errors);
  const checks = normalizeList(raw.checks ?? [], normalizeCommand, "front_matter.checks", 1, MAX_CHECKS, errors, false);

  const projectConcurrency = parseInteger(raw.concurrency?.project ?? "", 1, 16, "front_matter.concurrency.project", errors);
  const globalConcurrency = parseInteger(raw.concurrency?.global ?? "", 1, 64, "front_matter.concurrency.global", errors);
  if (projectConcurrency !== null && globalConcurrency !== null && projectConcurrency > globalConcurrency) {
    addError(errors, "invalid_value", "front_matter.concurrency.project", "Project concurrency cannot exceed global concurrency");
  }

  const approvalSet = new Set(approvalRequired);
  for (const action of REQUIRED_APPROVAL_ACTIONS) {
    if (!approvalSet.has(action)) {
      addError(errors, "invalid_value", "front_matter.approval_required", `Version 1 requires approval for ${action}`);
    }
  }
  const overlap = autonomousActions.filter((action) => approvalSet.has(action));
  if (overlap.length > 0) {
    addError(errors, "invalid_value", "front_matter.autonomous_actions", `Actions cannot be both autonomous and approval-required: ${overlap.join(", ")}`);
  }
  if (errors.length > 0 || version === null || !project || projectConcurrency === null || globalConcurrency === null) return null;

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

function normalizeActionList(
  values: string[],
  path: string,
  errors: ProjectAttachmentValidationError[],
): ProjectAttachmentAction[] {
  const normalized = normalizeList(values, normalizeAction, path, 0, MAX_LIST_ITEMS, errors);
  return normalized.filter((value): value is ProjectAttachmentAction => ACTION_SET.has(value));
}

function normalizeAction(value: string): string | null {
  const normalized = normalizeIdentifier(value, 64)?.replace(/-/g, "_") ?? null;
  return normalized && ACTION_SET.has(normalized) ? normalized : null;
}

function normalizeRepository(value: string): string | null {
  const normalized = normalizeSimpleText(value, 160)?.toLowerCase();
  if (!normalized || normalized.endsWith(".git")) return null;
  const parts = normalized.split("/");
  if (parts.length !== 2) return null;
  const [owner, repository] = parts;
  if (!owner || !repository) return null;
  const segment = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
  if (!segment.test(owner) || !segment.test(repository)) return null;
  return `${owner}/${repository}`;
}

function normalizeNamedIdentifier(value: string, maximum: number): string | null {
  const normalized = normalizeIdentifier(value, maximum)?.replace(/-/g, "-") ?? null;
  return normalized && /^[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : null;
}

function normalizeIdentifier(value: string, maximum: number): string | null {
  const normalized = normalizeSimpleText(value, maximum)?.toLowerCase();
  return normalized ?? null;
}

function normalizeCommand(value: string): string | null {
  const normalized = normalizeSimpleText(value, MAX_COMMAND_LENGTH)?.replace(/\s+/g, " ");
  if (!normalized || containsSecretShapedValue(normalized)) return null;
  if (/[;&|`<>]/.test(normalized) || /\$\(|\$\{|\\\s*$/.test(normalized)) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized)) return null;
  if (!/^[A-Za-z0-9_./:@%+=,* -]+$/.test(normalized)) return null;
  const executable = normalized.split(" ")[0] ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(executable) ? normalized : null;
}

function normalizeList<T extends string>(
  values: string[],
  normalize: (value: string) => T | null,
  path: string,
  minimum: number,
  maximum: number,
  errors: ProjectAttachmentValidationError[],
  sortValues = true,
): T[] {
  if (values.length < minimum || values.length > maximum) {
    addError(errors, "invalid_value", path, `List must contain between ${minimum} and ${maximum} items`);
  }
  const result: T[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const normalized = normalize(value);
    if (!normalized) {
      addError(errors, "invalid_value", `${path}[${index}]`, "Invalid or unsafe value");
      continue;
    }
    if (seen.has(normalized)) {
      addError(errors, "duplicate_value", `${path}[${index}]`, "Duplicate value after normalisation");
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return sortValues ? result.sort((left, right) => left.localeCompare(right)) : result;
}

function normalizeSimpleText(value: string, maximum: number): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) return null;
  if (/\t/.test(normalized) || /[\u0000-\u001F\u007F]/.test(normalized)) return null;
  return normalized;
}

function normalizeBodyText(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function parseInteger(
  value: string,
  minimum: number,
  maximum: number,
  path: string,
  errors: ProjectAttachmentValidationError[],
): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    addError(errors, "invalid_value", path, "Expected a base-10 integer");
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    addError(errors, "invalid_value", path, `Value must be between ${minimum} and ${maximum}`);
    return null;
  }
  return parsed;
}

function containsSecretShapedValue(value: string): boolean {
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_]{12,}\b/,
    /\bsk-[A-Za-z0-9_-]{12,}\b/,
    /\bstn\.tok_[A-Za-z0-9._-]{8,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i,
    /\b(?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/i,
  ].some((pattern) => pattern.test(value));
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function setRawList(result: RawFrontMatter, key: string, values: string[]): void {
  if (key === "repositories" || key === "runner_profiles" || key === "autonomous_actions" || key === "approval_required" || key === "checks") {
    result[key] = values;
  }
}

function bodyKey(heading: typeof BODY_HEADINGS[number]): keyof ProjectAttachmentBody {
  if (heading === "Goal") return "goal";
  if (heading === "Boundaries") return "boundaries";
  if (heading === "Evidence and handoff expectations") return "evidenceAndHandoff";
  return "escalation";
}

function compareSets(
  previous: readonly string[],
  proposed: readonly string[],
  trackOrder = false,
): ProjectAttachmentSetChange {
  const before = new Set(previous);
  const after = new Set(proposed);
  return {
    added: [...after].filter((value) => !before.has(value)).sort(),
    removed: [...before].filter((value) => !after.has(value)).sort(),
    orderChanged: trackOrder && previous.length === proposed.length &&
      previous.some((value, index) => value !== proposed[index]),
  };
}

function compareNumber(previous: number, proposed: number): "increased" | "decreased" | "unchanged" {
  if (proposed > previous) return "increased";
  if (proposed < previous) return "decreased";
  return "unchanged";
}

function hasSetChange(change: ProjectAttachmentSetChange): boolean {
  return change.added.length > 0 || change.removed.length > 0;
}

function addError(
  errors: ProjectAttachmentValidationError[],
  code: ProjectAttachmentValidationError["code"],
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

function failure(errors: ProjectAttachmentValidationError[]): ProjectAttachmentParseResult {
  return {
    ok: false,
    errors: [...errors].sort((left, right) =>
      left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
    ),
  };
}
