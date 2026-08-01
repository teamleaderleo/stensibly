import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

export const GITHUB_OUTBOUND_TEXT_POLICY_SCHEMA_VERSION = 1 as const;
export const GITHUB_OUTBOUND_TEXT_POLICY_VERSION = 1 as const;
export const GITHUB_OUTBOUND_SURFACES = [
  "issue",
  "pull_request",
  "comment",
  "review",
  "inline_review",
  "discussion",
  "commit_message",
] as const;
export const GITHUB_OUTBOUND_REFERENCE_KINDS = [
  "direct_item_url",
  "cross_repository_item_shorthand",
  "cross_repository_commit_shorthand",
  "closing_reference",
] as const;

export type GitHubOutboundSurface = typeof GITHUB_OUTBOUND_SURFACES[number];
export type GitHubOutboundReferenceKind = typeof GITHUB_OUTBOUND_REFERENCE_KINDS[number];

export interface GitHubOutboundRepository {
  owner: string;
  repository: string;
}

export interface GitHubOutboundTextField {
  name: string;
  text: string;
}

export interface GitHubOutboundTextPolicy {
  version: typeof GITHUB_OUTBOUND_TEXT_POLICY_VERSION;
  controlledOwners: string[];
  controlledRepositories: string[];
}

export interface GitHubExternalContactAuthority {
  fingerprint: string;
  generation: number;
  repositories: string[];
}

export interface GitHubOutboundTextInput {
  workspace: string;
  project: string;
  destination: GitHubOutboundRepository;
  surface: GitHubOutboundSurface;
  operationRef: string;
  authorityGeneration: number;
  fields: GitHubOutboundTextField[];
  policy: GitHubOutboundTextPolicy;
  externalContactAuthority: GitHubExternalContactAuthority | null;
}

export interface GitHubOutboundReferenceDiagnostic {
  field: string;
  line: number;
  column: number;
  kind: GitHubOutboundReferenceKind;
  owner: string;
  repository: string;
  itemKind: "issue" | "pull_request" | "discussion" | "commit";
  itemIdentity: string;
  rule: "external_reference_requires_authority";
  authorityRequired: true;
}

export interface GitHubOutboundTextReceipt {
  schemaVersion: typeof GITHUB_OUTBOUND_TEXT_POLICY_SCHEMA_VERSION;
  workspace: string;
  project: string;
  destination: GitHubOutboundRepository & { repositoryFullName: string };
  surface: GitHubOutboundSurface;
  operationRef: string;
  authorityGeneration: number;
  externalContactAuthorityFingerprint: string | null;
  externalContactAuthorityGeneration: number | null;
  policyFingerprint: string;
  payloadFingerprint: string;
  fields: Array<{
    name: string;
    textSha256: string;
    byteLength: number;
    lineCount: number;
  }>;
  referenceCounts: {
    total: number;
    controlled: number;
    authorized: number;
    rejected: number;
    omittedDiagnostics: number;
  };
  diagnostics: GitHubOutboundReferenceDiagnostic[];
  decision: "allow" | "reject";
  providerDispatchAuthorized: false;
  receiptFingerprint: string;
}

interface ParsedInput
  extends Omit<
    GitHubOutboundTextInput,
    "destination" | "fields" | "policy" | "externalContactAuthority"
  > {
  destination: GitHubOutboundRepository & { repositoryFullName: string };
  fields: GitHubOutboundTextField[];
  policy: GitHubOutboundTextPolicy;
  externalContactAuthority: GitHubExternalContactAuthority | null;
}

interface ReferenceObservation extends GitHubOutboundReferenceDiagnostic {
  controlled: boolean;
  authorized: boolean;
}

const MAX_TOTAL_TEXT_BYTES = 128 * 1024;
const MAX_FIELD_TEXT_BYTES = 96 * 1024;
const MAX_DIAGNOSTICS = 100;

const expectedFields: Record<GitHubOutboundSurface, readonly string[]> = {
  issue: ["title", "body"],
  pull_request: ["title", "body"],
  comment: ["body"],
  review: ["body"],
  inline_review: ["body"],
  discussion: ["title", "body"],
  commit_message: ["message"],
};

const directItemUrl =
  /https?:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/(issues|pull|discussions)\/([1-9][0-9]{0,9})\b/gi;
const directCommitUrl =
  /https?:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/commit\/([0-9a-fA-F]{7,40})\b/gi;
const itemShorthand =
  /(^|[^A-Za-z0-9_.-])([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,9})\b/g;
const commitShorthand =
  /(^|[^A-Za-z0-9_.-])([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})@([0-9a-fA-F]{7,40})\b/g;
const closingPrefix = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*$/i;
const realisticCredentialPattern =
  /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:env|secret):\/\/[^\s]+|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/u;

export function evaluateGitHubOutboundText(
  input: unknown,
): GitHubOutboundTextReceipt {
  const parsed = parseInput(input);
  const controlledOwners = new Set(parsed.policy.controlledOwners);
  const controlledRepositories = new Set(parsed.policy.controlledRepositories);
  const authorizedRepositories = new Set(
    parsed.externalContactAuthority?.repositories ?? [],
  );
  const observations: ReferenceObservation[] = [];

  for (const field of parsed.fields) {
    observations.push(
      ...scanField(
        field,
        parsed.destination.repositoryFullName,
        controlledOwners,
        controlledRepositories,
        authorizedRepositories,
      ),
    );
  }

  const rejected = observations.filter(
    (observation) => !observation.controlled && !observation.authorized,
  );
  const diagnostics = rejected
    .slice(0, MAX_DIAGNOSTICS)
    .map(
      ({ controlled: _controlled, authorized: _authorized, ...diagnostic }) =>
        diagnostic,
    );
  const fields = parsed.fields.map((field) => ({
    name: field.name,
    textSha256: fingerprintCanonicalRequest({ text: field.text }),
    byteLength: new TextEncoder().encode(field.text).byteLength,
    lineCount: field.text.split("\n").length,
  }));
  const policyFingerprint = fingerprintCanonicalRequest(parsed.policy);
  const payloadFingerprint = fingerprintCanonicalRequest({
    destination: parsed.destination,
    surface: parsed.surface,
    fields: parsed.fields,
  });
  const withoutFingerprint = {
    schemaVersion: GITHUB_OUTBOUND_TEXT_POLICY_SCHEMA_VERSION,
    workspace: parsed.workspace,
    project: parsed.project,
    destination: parsed.destination,
    surface: parsed.surface,
    operationRef: parsed.operationRef,
    authorityGeneration: parsed.authorityGeneration,
    externalContactAuthorityFingerprint:
      parsed.externalContactAuthority?.fingerprint ?? null,
    externalContactAuthorityGeneration:
      parsed.externalContactAuthority?.generation ?? null,
    policyFingerprint,
    payloadFingerprint,
    fields,
    referenceCounts: {
      total: observations.length,
      controlled: observations.filter((observation) => observation.controlled)
        .length,
      authorized: observations.filter(
        (observation) => !observation.controlled && observation.authorized,
      ).length,
      rejected: rejected.length,
      omittedDiagnostics: Math.max(0, rejected.length - diagnostics.length),
    },
    diagnostics,
    decision: rejected.length ? ("reject" as const) : ("allow" as const),
    providerDispatchAuthorized: false as const,
  };
  return deepFreeze({
    ...withoutFingerprint,
    receiptFingerprint: fingerprintCanonicalRequest(withoutFingerprint),
  });
}

export function parseGitHubOutboundTextReceipt(
  input: unknown,
): GitHubOutboundTextReceipt {
  const record = requireRecord(input, "GitHub outbound text receipt");
  rejectUnknownKeys(
    record,
    [
      "schemaVersion",
      "workspace",
      "project",
      "destination",
      "surface",
      "operationRef",
      "authorityGeneration",
      "externalContactAuthorityFingerprint",
      "externalContactAuthorityGeneration",
      "policyFingerprint",
      "payloadFingerprint",
      "fields",
      "referenceCounts",
      "diagnostics",
      "decision",
      "providerDispatchAuthorized",
      "receiptFingerprint",
    ],
    "GitHub outbound text receipt",
  );
  if (record.schemaVersion !== GITHUB_OUTBOUND_TEXT_POLICY_SCHEMA_VERSION) {
    throw new Error(
      "GitHub outbound text receipt schema version is unsupported",
    );
  }

  const destination = parseDestination(
    record.destination,
    "GitHub outbound receipt destination",
  );
  const surface = closedValue(
    record.surface,
    GITHUB_OUTBOUND_SURFACES,
    "GitHub outbound surface",
  );
  const fields = parseReceiptFields(record.fields, surface);
  const counts = parseReferenceCounts(record.referenceCounts);
  const diagnostics = parseDiagnostics(record.diagnostics);
  if (
    counts.total !== counts.controlled + counts.authorized + counts.rejected ||
    counts.omittedDiagnostics !== counts.rejected - diagnostics.length ||
    diagnostics.length !== Math.min(counts.rejected, MAX_DIAGNOSTICS)
  ) {
    throw new Error("GitHub outbound text reference counts are inconsistent");
  }
  const fieldNames = new Set(fields.map((field) => field.name));
  if (diagnostics.some((diagnostic) => !fieldNames.has(diagnostic.field))) {
    throw new Error("GitHub outbound diagnostics reference an unknown field");
  }

  const decision = closedValue(
    record.decision,
    ["allow", "reject"] as const,
    "GitHub outbound decision",
  );
  if ((decision === "allow") !== (counts.rejected === 0)) {
    throw new Error(
      "GitHub outbound decision does not match rejected references",
    );
  }
  if (record.providerDispatchAuthorized !== false) {
    throw new Error(
      "GitHub outbound policy receipt cannot authorize provider dispatch",
    );
  }

  const parsedWithoutFingerprint = {
    schemaVersion: GITHUB_OUTBOUND_TEXT_POLICY_SCHEMA_VERSION,
    workspace: boundedSlug(record.workspace, "GitHub outbound workspace", 80),
    project: boundedSlug(record.project, "GitHub outbound project", 80),
    destination,
    surface,
    operationRef: boundedIdentifier(
      record.operationRef,
      "GitHub outbound operation reference",
      160,
    ),
    authorityGeneration: positiveInteger(
      record.authorityGeneration,
      "GitHub outbound authority generation",
    ),
    externalContactAuthorityFingerprint:
      record.externalContactAuthorityFingerprint === null
        ? null
        : sha256(
            record.externalContactAuthorityFingerprint,
            "External contact authority fingerprint",
          ),
    externalContactAuthorityGeneration:
      record.externalContactAuthorityGeneration === null
        ? null
        : positiveInteger(
            record.externalContactAuthorityGeneration,
            "External contact authority generation",
          ),
    policyFingerprint: sha256(
      record.policyFingerprint,
      "GitHub outbound policy fingerprint",
    ),
    payloadFingerprint: sha256(
      record.payloadFingerprint,
      "GitHub outbound payload fingerprint",
    ),
    fields,
    referenceCounts: counts,
    diagnostics,
    decision,
    providerDispatchAuthorized: false as const,
  };

  if (
    (parsedWithoutFingerprint.externalContactAuthorityFingerprint === null) !==
    (parsedWithoutFingerprint.externalContactAuthorityGeneration === null)
  ) {
    throw new Error("External contact authority identity is incomplete");
  }
  if (
    parsedWithoutFingerprint.externalContactAuthorityGeneration !== null &&
    parsedWithoutFingerprint.externalContactAuthorityGeneration !==
      parsedWithoutFingerprint.authorityGeneration
  ) {
    throw new Error(
      "External contact authority generation does not match the provider operation",
    );
  }
  if (
    parsedWithoutFingerprint.externalContactAuthorityFingerprint === null &&
    counts.authorized !== 0
  ) {
    throw new Error(
      "Authorized references require an external contact authority",
    );
  }

  const receiptFingerprint = sha256(
    record.receiptFingerprint,
    "GitHub outbound receipt fingerprint",
  );
  if (
    receiptFingerprint !== fingerprintCanonicalRequest(parsedWithoutFingerprint)
  ) {
    throw new Error(
      "GitHub outbound receipt fingerprint does not match its contents",
    );
  }
  return deepFreeze({ ...parsedWithoutFingerprint, receiptFingerprint });
}

function parseInput(input: unknown): ParsedInput {
  const record = requireRecord(input, "GitHub outbound text input");
  rejectUnknownKeys(
    record,
    [
      "workspace",
      "project",
      "destination",
      "surface",
      "operationRef",
      "authorityGeneration",
      "fields",
      "policy",
      "externalContactAuthority",
    ],
    "GitHub outbound text input",
  );
  const surface = closedValue(
    record.surface,
    GITHUB_OUTBOUND_SURFACES,
    "GitHub outbound surface",
  );
  const fields = parseFields(record.fields, surface);
  const totalBytes = fields.reduce(
    (sum, field) => sum + new TextEncoder().encode(field.text).byteLength,
    0,
  );
  if (totalBytes > MAX_TOTAL_TEXT_BYTES) {
    throw new Error("GitHub outbound text payload is too large");
  }

  const authorityGeneration = positiveInteger(
    record.authorityGeneration,
    "GitHub outbound authority generation",
  );
  const externalContactAuthority =
    record.externalContactAuthority === null
      ? null
      : parseExternalAuthority(record.externalContactAuthority);
  if (
    externalContactAuthority !== null &&
    externalContactAuthority.generation !== authorityGeneration
  ) {
    throw new Error(
      "External contact authority generation does not match the provider operation",
    );
  }

  return {
    workspace: boundedSlug(record.workspace, "GitHub outbound workspace", 80),
    project: boundedSlug(record.project, "GitHub outbound project", 80),
    destination: parseDestination(
      record.destination,
      "GitHub outbound destination",
    ),
    surface,
    operationRef: boundedIdentifier(
      record.operationRef,
      "GitHub outbound operation reference",
      160,
    ),
    authorityGeneration,
    fields,
    policy: parsePolicy(record.policy),
    externalContactAuthority,
  };
}

function parseFields(
  input: unknown,
  surface: GitHubOutboundSurface,
): GitHubOutboundTextField[] {
  const values = exactDenseArray(input, "GitHub outbound text fields", 2);
  const names = expectedFields[surface];
  if (values.length !== names.length) {
    throw new Error(`GitHub outbound ${surface} fields are incomplete`);
  }
  const parsed = values.map((entry) => {
    const record = requireRecord(entry, "GitHub outbound text field");
    rejectUnknownKeys(
      record,
      ["name", "text"],
      "GitHub outbound text field",
    );
    if (typeof record.name !== "string" || !names.includes(record.name)) {
      throw new Error(`GitHub outbound ${surface} field name is invalid`);
    }
    if (typeof record.text !== "string") {
      throw new Error("GitHub outbound text field must contain text");
    }
    if (new TextEncoder().encode(record.text).byteLength > MAX_FIELD_TEXT_BYTES) {
      throw new Error(`GitHub outbound ${record.name} field is too large`);
    }
    return { name: record.name, text: record.text };
  });
  if (
    JSON.stringify(parsed.map((field) => field.name)) !== JSON.stringify(names)
  ) {
    throw new Error(
      `GitHub outbound ${surface} fields must be unique and in canonical order`,
    );
  }
  return parsed;
}

function parsePolicy(input: unknown): GitHubOutboundTextPolicy {
  const record = requireRecord(input, "GitHub outbound text policy");
  rejectUnknownKeys(
    record,
    ["version", "controlledOwners", "controlledRepositories"],
    "GitHub outbound text policy",
  );
  if (record.version !== GITHUB_OUTBOUND_TEXT_POLICY_VERSION) {
    throw new Error("GitHub outbound text policy version is unsupported");
  }
  const controlledOwners = canonicalStringArray(
    record.controlledOwners,
    "Controlled GitHub owners",
    parseOwner,
  );
  const controlledRepositories = canonicalStringArray(
    record.controlledRepositories,
    "Controlled GitHub repositories",
    parseRepositoryFullName,
  );
  return {
    version: GITHUB_OUTBOUND_TEXT_POLICY_VERSION,
    controlledOwners,
    controlledRepositories,
  };
}

function parseExternalAuthority(input: unknown): GitHubExternalContactAuthority {
  const record = requireRecord(input, "GitHub external contact authority");
  rejectUnknownKeys(
    record,
    ["fingerprint", "generation", "repositories"],
    "GitHub external contact authority",
  );
  return {
    fingerprint: sha256(
      record.fingerprint,
      "GitHub external contact authority fingerprint",
    ),
    generation: positiveInteger(
      record.generation,
      "GitHub external contact authority generation",
    ),
    repositories: canonicalStringArray(
      record.repositories,
      "Authorized external repositories",
      parseRepositoryFullName,
    ),
  };
}

function scanField(
  field: GitHubOutboundTextField,
  destinationRepository: string,
  controlledOwners: Set<string>,
  controlledRepositories: Set<string>,
  authorizedRepositories: Set<string>,
): ReferenceObservation[] {
  const observations: ReferenceObservation[] = [];
  const lines = field.text.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    for (const match of line.matchAll(directItemUrl)) {
      const owner = normalizeReferenceOwner(match[1]);
      const repository = normalizeReferenceRepository(match[2]);
      const repositoryFullName = `${owner}/${repository}`;
      const itemKind = providerPathKind(match[3]);
      observations.push(
        observation({
          field: field.name,
          line: lineIndex + 1,
          column: (match.index ?? 0) + 1,
          kind: closingPrefix.test(line.slice(0, match.index ?? 0))
            ? "closing_reference"
            : "direct_item_url",
          owner,
          repository,
          itemKind,
          itemIdentity: boundedItemIdentity(match[4], itemKind),
          repositoryFullName,
          destinationRepository,
          controlledOwners,
          controlledRepositories,
          authorizedRepositories,
        }),
      );
    }
    for (const match of line.matchAll(directCommitUrl)) {
      const owner = normalizeReferenceOwner(match[1]);
      const repository = normalizeReferenceRepository(match[2]);
      const repositoryFullName = `${owner}/${repository}`;
      observations.push(
        observation({
          field: field.name,
          line: lineIndex + 1,
          column: (match.index ?? 0) + 1,
          kind: closingPrefix.test(line.slice(0, match.index ?? 0))
            ? "closing_reference"
            : "direct_item_url",
          owner,
          repository,
          itemKind: "commit",
          itemIdentity: match[3]!.slice(0, 12).toLowerCase(),
          repositoryFullName,
          destinationRepository,
          controlledOwners,
          controlledRepositories,
          authorizedRepositories,
        }),
      );
    }
    for (const match of line.matchAll(itemShorthand)) {
      const owner = normalizeReferenceOwner(match[2]);
      const repository = normalizeReferenceRepository(match[3]);
      const repositoryFullName = `${owner}/${repository}`;
      const start = (match.index ?? 0) + match[1]!.length;
      observations.push(
        observation({
          field: field.name,
          line: lineIndex + 1,
          column: start + 1,
          kind: closingPrefix.test(line.slice(0, start))
            ? "closing_reference"
            : "cross_repository_item_shorthand",
          owner,
          repository,
          itemKind: "issue",
          itemIdentity: match[4]!,
          repositoryFullName,
          destinationRepository,
          controlledOwners,
          controlledRepositories,
          authorizedRepositories,
        }),
      );
    }
    for (const match of line.matchAll(commitShorthand)) {
      const owner = normalizeReferenceOwner(match[2]);
      const repository = normalizeReferenceRepository(match[3]);
      const repositoryFullName = `${owner}/${repository}`;
      const start = (match.index ?? 0) + match[1]!.length;
      observations.push(
        observation({
          field: field.name,
          line: lineIndex + 1,
          column: start + 1,
          kind: "cross_repository_commit_shorthand",
          owner,
          repository,
          itemKind: "commit",
          itemIdentity: match[4]!.slice(0, 12).toLowerCase(),
          repositoryFullName,
          destinationRepository,
          controlledOwners,
          controlledRepositories,
          authorizedRepositories,
        }),
      );
    }
  }
  return observations;
}

function observation(
  input: Omit<
    ReferenceObservation,
    "controlled" | "authorized" | "rule" | "authorityRequired"
  > & {
    repositoryFullName: string;
    destinationRepository: string;
    controlledOwners: Set<string>;
    controlledRepositories: Set<string>;
    authorizedRepositories: Set<string>;
  },
): ReferenceObservation {
  const controlled =
    input.repositoryFullName === input.destinationRepository ||
    input.controlledOwners.has(input.owner) ||
    input.controlledRepositories.has(input.repositoryFullName);
  const authorized =
    !controlled && input.authorizedRepositories.has(input.repositoryFullName);
  return {
    field: input.field,
    line: input.line,
    column: input.column,
    kind: input.kind,
    owner: input.owner,
    repository: input.repository,
    itemKind: input.itemKind,
    itemIdentity: input.itemIdentity,
    rule: "external_reference_requires_authority",
    authorityRequired: true,
    controlled,
    authorized,
  };
}

function parseDestination(
  input: unknown,
  label: string,
): GitHubOutboundRepository & { repositoryFullName: string } {
  const record = requireRecord(input, label);
  rejectUnknownKeys(
    record,
    ["owner", "repository", "repositoryFullName"],
    label,
  );
  const owner = parseOwner(record.owner);
  const repository = parseRepository(record.repository);
  const repositoryFullName = `${owner}/${repository}`;
  if (record.owner !== owner || record.repository !== repository) {
    throw new Error(`${label} identity is not canonical`);
  }
  if (
    Object.hasOwn(record, "repositoryFullName") &&
    record.repositoryFullName !== repositoryFullName
  ) {
    throw new Error(`${label} full name is not canonical`);
  }
  return { owner, repository, repositoryFullName };
}

function parseReceiptFields(
  input: unknown,
  surface: GitHubOutboundSurface,
): GitHubOutboundTextReceipt["fields"] {
  const values = exactDenseArray(input, "GitHub outbound receipt fields", 2);
  const names = expectedFields[surface];
  if (values.length !== names.length) {
    throw new Error("GitHub outbound receipt fields do not match the surface");
  }
  const fields = values.map((entry) => {
    const record = requireRecord(entry, "GitHub outbound receipt field");
    rejectUnknownKeys(
      record,
      ["name", "textSha256", "byteLength", "lineCount"],
      "GitHub outbound receipt field",
    );
    return {
      name: boundedIdentifier(
        record.name,
        "GitHub outbound receipt field name",
        40,
      ),
      textSha256: sha256(
        record.textSha256,
        "GitHub outbound text fingerprint",
      ),
      byteLength: boundedInteger(
        record.byteLength,
        "GitHub outbound field byte length",
        0,
        MAX_FIELD_TEXT_BYTES,
      ),
      lineCount: boundedInteger(
        record.lineCount,
        "GitHub outbound field line count",
        1,
        100_000,
      ),
    };
  });
  if (
    JSON.stringify(fields.map((field) => field.name)) !== JSON.stringify(names)
  ) {
    throw new Error("GitHub outbound receipt fields do not match the surface");
  }
  return fields;
}

function parseReferenceCounts(
  input: unknown,
): GitHubOutboundTextReceipt["referenceCounts"] {
  const record = requireRecord(input, "GitHub outbound reference counts");
  rejectUnknownKeys(
    record,
    ["total", "controlled", "authorized", "rejected", "omittedDiagnostics"],
    "GitHub outbound reference counts",
  );
  return {
    total: boundedInteger(
      record.total,
      "GitHub outbound total reference count",
      0,
      1_000_000,
    ),
    controlled: boundedInteger(
      record.controlled,
      "GitHub outbound controlled reference count",
      0,
      1_000_000,
    ),
    authorized: boundedInteger(
      record.authorized,
      "GitHub outbound authorized reference count",
      0,
      1_000_000,
    ),
    rejected: boundedInteger(
      record.rejected,
      "GitHub outbound rejected reference count",
      0,
      1_000_000,
    ),
    omittedDiagnostics: boundedInteger(
      record.omittedDiagnostics,
      "GitHub outbound omitted diagnostic count",
      0,
      1_000_000,
    ),
  };
}

function parseDiagnostics(input: unknown): GitHubOutboundReferenceDiagnostic[] {
  const values = exactDenseArray(
    input,
    "GitHub outbound diagnostics",
    MAX_DIAGNOSTICS,
  );
  return values.map((entry) => {
    const record = requireRecord(entry, "GitHub outbound diagnostic");
    rejectUnknownKeys(
      record,
      [
        "field",
        "line",
        "column",
        "kind",
        "owner",
        "repository",
        "itemKind",
        "itemIdentity",
        "rule",
        "authorityRequired",
      ],
      "GitHub outbound diagnostic",
    );
    if (
      record.rule !== "external_reference_requires_authority" ||
      record.authorityRequired !== true
    ) {
      throw new Error("GitHub outbound diagnostic rule is invalid");
    }
    return {
      field: boundedIdentifier(
        record.field,
        "GitHub outbound diagnostic field",
        40,
      ),
      line: boundedInteger(
        record.line,
        "GitHub outbound diagnostic line",
        1,
        100_000,
      ),
      column: boundedInteger(
        record.column,
        "GitHub outbound diagnostic column",
        1,
        1_000_000,
      ),
      kind: closedValue(
        record.kind,
        GITHUB_OUTBOUND_REFERENCE_KINDS,
        "GitHub outbound reference kind",
      ),
      owner: parseOwner(record.owner),
      repository: parseRepository(record.repository),
      itemKind: closedValue(
        record.itemKind,
        ["issue", "pull_request", "discussion", "commit"] as const,
        "GitHub outbound item kind",
      ),
      itemIdentity: boundedIdentifier(
        record.itemIdentity,
        "GitHub outbound item identity",
        40,
      ),
      rule: "external_reference_requires_authority",
      authorityRequired: true,
    };
  });
}

function providerPathKind(
  value: string | undefined,
): GitHubOutboundReferenceDiagnostic["itemKind"] {
  switch (value) {
    case "issues":
      return "issue";
    case "pull":
      return "pull_request";
    case "discussions":
      return "discussion";
    default:
      throw new Error("GitHub outbound item path is invalid");
  }
}

function boundedItemIdentity(
  value: string | undefined,
  kind: GitHubOutboundReferenceDiagnostic["itemKind"],
): string {
  if (!value) {
    throw new Error("GitHub outbound item identity is missing");
  }
  if (kind === "commit") {
    if (!/^[0-9a-fA-F]{7,40}$/.test(value)) {
      throw new Error("GitHub commit identity is invalid");
    }
    return value.slice(0, 12).toLowerCase();
  }
  if (!/^[1-9][0-9]{0,9}$/.test(value)) {
    throw new Error("GitHub item number is invalid");
  }
  return value;
}

function canonicalStringArray(
  input: unknown,
  label: string,
  parser: (value: unknown) => string,
): string[] {
  const values = exactDenseArray(input, label, 100);
  const parsed = values.map(parser);
  const sorted = [...parsed].sort(codeUnitCompare);
  if (
    new Set(parsed).size !== parsed.length ||
    JSON.stringify(parsed) !== JSON.stringify(sorted)
  ) {
    throw new Error(`${label} must be unique and in canonical order`);
  }
  return parsed;
}

function parseRepositoryFullName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("GitHub repository full name must be text");
  }
  const parts = value.split("/");
  if (parts.length !== 2) {
    throw new Error("GitHub repository full name is invalid");
  }
  const owner = parseOwner(parts[0]);
  const repository = parseRepository(parts[1]);
  const canonical = `${owner}/${repository}`;
  if (value !== canonical) {
    throw new Error("GitHub repository full name is not canonical");
  }
  return canonical;
}

function parseOwner(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("GitHub owner is invalid");
  }
  const canonical = value.normalize("NFKC").trim().toLowerCase();
  if (
    value !== canonical ||
    canonical.includes("--") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(canonical)
  ) {
    throw new Error("GitHub owner identity is not canonical");
  }
  return canonical;
}

function parseRepository(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("GitHub repository is invalid");
  }
  const canonical = value.normalize("NFKC").trim().toLowerCase();
  if (
    value !== canonical ||
    canonical.length < 1 ||
    canonical.length > 100 ||
    canonical === "." ||
    canonical === ".." ||
    canonical.includes("..") ||
    !/^[a-z0-9_.-]+$/.test(canonical)
  ) {
    throw new Error("GitHub repository identity is not canonical");
  }
  return canonical;
}

function normalizeReferenceOwner(value: string | undefined): string {
  if (typeof value !== "string") {
    throw new Error("GitHub reference owner is invalid");
  }
  const canonical = value.normalize("NFKC").trim().toLowerCase();
  if (
    canonical.includes("--") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(canonical)
  ) {
    throw new Error("GitHub reference owner is invalid");
  }
  return canonical;
}

function normalizeReferenceRepository(value: string | undefined): string {
  if (typeof value !== "string") {
    throw new Error("GitHub reference repository is invalid");
  }
  const canonical = value.normalize("NFKC").trim().toLowerCase();
  if (
    canonical.length < 1 ||
    canonical.length > 100 ||
    canonical === "." ||
    canonical === ".." ||
    canonical.includes("..") ||
    !/^[a-z0-9_.-]+$/.test(canonical)
  ) {
    throw new Error("GitHub reference repository is invalid");
  }
  return canonical;
}

function boundedSlug(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(value) ||
    realisticCredentialPattern.test(value)
  ) {
    throw new Error(`${label} must be a bounded lowercase slug`);
  }
  return value;
}

function boundedIdentifier(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/.test(value) ||
    realisticCredentialPattern.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 identifier`);
  }
  return value;
}

function closedValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new Error(`${label} is invalid`);
  }
  return value as T[number];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must contain only enumerable data properties`);
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error(`${label} must contain only enumerable data properties`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactDenseArray(
  value: unknown,
  label: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a dense undecorated array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximum
  ) {
    throw new Error(`${label} must be a dense undecorated array`);
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== length + 1 ||
    !keys.includes("length")
  ) {
    throw new Error(`${label} must be a dense undecorated array`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error(`${label} must be a dense undecorated array`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort(codeUnitCompare);
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field ${unknown[0]}`);
  }
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
