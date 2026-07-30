import {
  boundedText,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

export const githubToolRiskClasses = ["read", "write", "admin"] as const;
export type GitHubToolRiskClass = typeof githubToolRiskClasses[number];

export interface GitHubToolDefinitionInput {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  riskClass: GitHubToolRiskClass;
  repositoryScoped: boolean;
  requiresApproval: boolean;
}

export interface GitHubToolsetInput {
  name: string;
  description: string;
  defaultEnabled: boolean;
  tools: GitHubToolDefinitionInput[];
}

export interface GitHubToolCatalogueInput {
  version: 1;
  source: "github-mcp";
  sourceRevision: string;
  toolsets: GitHubToolsetInput[];
}

export interface GitHubToolDefinition extends GitHubToolDefinitionInput {
  toolset: string;
}

export interface GitHubToolset {
  name: string;
  description: string;
  defaultEnabled: boolean;
  tools: GitHubToolDefinition[];
}

export interface GitHubToolCatalogue {
  version: 1;
  source: "github-mcp";
  sourceRevision: string;
  toolsets: GitHubToolset[];
  toolCount: number;
  fingerprint: string;
}

export interface GitHubToolSearchResult extends GitHubToolDefinition {
  score: number;
}

export type GitHubToolCatalogueChangeClass =
  | "unchanged"
  | "additive"
  | "compatible"
  | "breaking";

export interface GitHubToolCatalogueChange {
  classification: GitHubToolCatalogueChangeClass;
  previousFingerprint: string;
  nextFingerprint: string;
  addedTools: string[];
  removedTools: string[];
  changedTools: string[];
  reasons: string[];
}

const toolNamePattern = /^[a-z][a-z0-9_]{0,127}$/;
const toolsetNamePattern = /^[a-z][a-z0-9_]{0,63}$/;

export function compileGitHubToolCatalogue(
  input: GitHubToolCatalogueInput,
): GitHubToolCatalogue {
  if (input.version !== 1 || input.source !== "github-mcp") {
    throw new RangeError("GitHub tool catalogue version or source is unsupported");
  }
  if (!Array.isArray(input.toolsets) || input.toolsets.length > 40) {
    throw new RangeError("GitHub tool catalogue accepts at most 40 toolsets");
  }

  const sourceRevision = boundedText(
    input.sourceRevision,
    "GitHub tool catalogue source revision",
    512,
  );
  const toolsetNames = new Set<string>();
  const toolNames = new Set<string>();
  let toolCount = 0;
  const toolsets = input.toolsets.map((toolset) => {
    const name = catalogueName(
      toolset.name,
      "GitHub toolset name",
      toolsetNamePattern,
    );
    if (toolsetNames.has(name)) {
      throw new RangeError(`Duplicate GitHub toolset: ${name}`);
    }
    toolsetNames.add(name);
    if (!Array.isArray(toolset.tools) || toolset.tools.length > 200) {
      throw new RangeError(`GitHub toolset ${name} accepts at most 200 tools`);
    }
    const tools = toolset.tools.map((tool) => {
      const toolName = catalogueName(
        tool.name,
        "GitHub tool name",
        toolNamePattern,
      );
      if (toolNames.has(toolName)) {
        throw new RangeError(`Duplicate GitHub tool: ${toolName}`);
      }
      toolNames.add(toolName);
      toolCount += 1;
      if (toolCount > 500) {
        throw new RangeError("GitHub tool catalogue accepts at most 500 tools");
      }
      const readOnly = booleanValue(tool.readOnly, `${toolName} read-only flag`);
      const riskClass = riskValue(tool.riskClass, toolName);
      if ((riskClass === "read") !== readOnly) {
        throw new RangeError(
          `GitHub tool ${toolName} must use read risk exactly when read-only`,
        );
      }
      return {
        name: toolName,
        toolset: name,
        description: boundedText(
          tool.description,
          `GitHub tool ${toolName} description`,
          1200,
        ),
        inputSchema: canonicalObject(
          tool.inputSchema,
          `GitHub tool ${toolName} input schema`,
        ),
        readOnly,
        riskClass,
        repositoryScoped: booleanValue(
          tool.repositoryScoped,
          `${toolName} repository-scoped flag`,
        ),
        requiresApproval: booleanValue(
          tool.requiresApproval,
          `${toolName} approval flag`,
        ),
      } satisfies GitHubToolDefinition;
    }).sort((left, right) => codeUnitCompare(left.name, right.name));
    return {
      name,
      description: boundedText(
        toolset.description,
        `GitHub toolset ${name} description`,
        800,
      ),
      defaultEnabled: booleanValue(
        toolset.defaultEnabled,
        `${name} default-enabled flag`,
      ),
      tools,
    } satisfies GitHubToolset;
  }).sort((left, right) => codeUnitCompare(left.name, right.name));

  const canonical = {
    version: 1 as const,
    source: "github-mcp" as const,
    sourceRevision,
    toolsets,
    toolCount,
  };
  return deepFreeze({
    ...canonical,
    fingerprint: sha256(stableJson(canonical)),
  });
}

export function searchGitHubTools(
  catalogue: GitHubToolCatalogue,
  input: {
    query: string;
    toolsets?: string[];
    readOnly?: boolean;
    limit?: number;
  },
): GitHubToolSearchResult[] {
  const query = boundedText(input.query, "GitHub tool search query", 200)
    .toLocaleLowerCase("en-US");
  const tokens = [...new Set(query.split(/\s+/u).filter(Boolean))];
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("GitHub tool search limit must be between 1 and 100");
  }
  const allowedToolsets = input.toolsets
    ? new Set(input.toolsets.map((value) => catalogueName(
      value,
      "GitHub toolset filter",
      toolsetNamePattern,
    )))
    : null;
  const readOnly = input.readOnly;
  if (readOnly !== undefined) booleanValue(readOnly, "GitHub read-only filter");

  return catalogue.toolsets
    .flatMap((toolset) => toolset.tools)
    .filter((tool) => !allowedToolsets || allowedToolsets.has(tool.toolset))
    .filter((tool) => readOnly === undefined || tool.readOnly === readOnly)
    .map((tool) => ({ ...tool, score: toolScore(tool, query, tokens) }))
    .filter((tool) => tool.score > 0)
    .sort((left, right) => right.score - left.score
      || codeUnitCompare(left.name, right.name))
    .slice(0, limit);
}

export function classifyGitHubToolCatalogueChange(
  previous: GitHubToolCatalogue,
  next: GitHubToolCatalogue,
): GitHubToolCatalogueChange {
  if (previous.fingerprint === next.fingerprint) {
    return {
      classification: "unchanged",
      previousFingerprint: previous.fingerprint,
      nextFingerprint: next.fingerprint,
      addedTools: [],
      removedTools: [],
      changedTools: [],
      reasons: [],
    };
  }

  const previousToolsets = new Map(previous.toolsets.map((entry) => [entry.name, entry]));
  const nextToolsets = new Map(next.toolsets.map((entry) => [entry.name, entry]));
  const previousTools = toolMap(previous);
  const nextTools = toolMap(next);
  const addedTools: string[] = [];
  const removedTools: string[] = [];
  const changedTools: string[] = [];
  const reasons: string[] = [];
  let breaking = false;
  let compatible = previous.sourceRevision !== next.sourceRevision;

  if (compatible) reasons.push("provider source revision changed");

  for (const name of previousToolsets.keys()) {
    if (!nextToolsets.has(name)) {
      breaking = true;
      reasons.push(`toolset removed: ${name}`);
    }
  }
  for (const [name, toolset] of nextToolsets) {
    const prior = previousToolsets.get(name);
    if (!prior) {
      reasons.push(`toolset added: ${name}`);
      continue;
    }
    if (prior.description !== toolset.description) {
      compatible = true;
      reasons.push(`toolset description changed: ${name}`);
    }
    if (prior.defaultEnabled !== toolset.defaultEnabled) {
      breaking = true;
      reasons.push(`breaking toolset default changed: ${name}`);
    }
  }

  for (const name of previousTools.keys()) {
    if (!nextTools.has(name)) {
      breaking = true;
      removedTools.push(name);
      reasons.push(`tool removed: ${name}`);
    }
  }
  for (const [name, tool] of nextTools) {
    const prior = previousTools.get(name);
    if (!prior) {
      addedTools.push(name);
      reasons.push(`tool added: ${name}`);
      continue;
    }
    const changes: string[] = [];
    if (prior.toolset !== tool.toolset) changes.push("toolset");
    if (stableJson(prior.inputSchema) !== stableJson(tool.inputSchema)) {
      changes.push("input schema");
    }
    if (prior.repositoryScoped !== tool.repositoryScoped) {
      changes.push("repository scope");
    }
    if (prior.requiresApproval !== tool.requiresApproval) {
      changes.push("approval requirement");
    }
    if (prior.riskClass !== tool.riskClass) changes.push("risk class");
    if (prior.readOnly !== tool.readOnly) changes.push("read-only capability");
    if (changes.length > 0) {
      breaking = true;
      changedTools.push(name);
      reasons.push(`breaking tool change ${name}: ${changes.join(", ")}`);
      continue;
    }
    if (prior.description !== tool.description) {
      compatible = true;
      changedTools.push(name);
      reasons.push(`compatible tool metadata changed: ${name}`);
    }
  }

  return {
    classification: breaking
      ? "breaking"
      : compatible
      ? "compatible"
      : addedTools.length > 0
      ? "additive"
      : "compatible",
    previousFingerprint: previous.fingerprint,
    nextFingerprint: next.fingerprint,
    addedTools: addedTools.sort(codeUnitCompare),
    removedTools: removedTools.sort(codeUnitCompare),
    changedTools: [...new Set(changedTools)].sort(codeUnitCompare),
    reasons,
  };
}

export const githubReadOnlySeedCatalogue = compileGitHubToolCatalogue({
  version: 1,
  source: "github-mcp",
  sourceRevision: "github-mcp-server:bounded-seed-v1",
  toolsets: [
    {
      name: "context",
      description: "Authenticated GitHub identity and operating context.",
      defaultEnabled: true,
      tools: [{
        name: "get_me",
        description: "Get the authenticated GitHub user profile.",
        inputSchema: objectSchema({}),
        readOnly: true,
        riskClass: "read",
        repositoryScoped: false,
        requiresApproval: false,
      }],
    },
    {
      name: "repos",
      description: "Repository metadata and bounded file reads.",
      defaultEnabled: true,
      tools: [{
        name: "get_file_contents",
        description: "Get file or directory contents from a repository.",
        inputSchema: objectSchema({
          owner: stringSchema(),
          repo: stringSchema(),
          path: stringSchema(),
          ref: stringSchema(),
        }, ["owner", "repo"]),
        readOnly: true,
        riskClass: "read",
        repositoryScoped: true,
        requiresApproval: false,
      }],
    },
    {
      name: "issues",
      description: "Issue reads and discussion context.",
      defaultEnabled: true,
      tools: [{
        name: "issue_read",
        description: "Read one issue or a bounded related issue view.",
        inputSchema: objectSchema({
          method: stringSchema(["get", "get_comments", "get_sub_issues"]),
          owner: stringSchema(),
          repo: stringSchema(),
          issue_number: integerSchema(1),
        }, ["method", "owner", "repo", "issue_number"]),
        readOnly: true,
        riskClass: "read",
        repositoryScoped: true,
        requiresApproval: false,
      }],
    },
    {
      name: "pull_requests",
      description: "Pull request state, files, reviews, and checks.",
      defaultEnabled: true,
      tools: [{
        name: "pull_request_read",
        description: "Read one pull request or a bounded related view.",
        inputSchema: objectSchema({
          method: stringSchema(),
          owner: stringSchema(),
          repo: stringSchema(),
          pullNumber: integerSchema(1),
        }, ["method", "owner", "repo", "pullNumber"]),
        readOnly: true,
        riskClass: "read",
        repositoryScoped: true,
        requiresApproval: false,
      }],
    },
    {
      name: "actions",
      description: "GitHub Actions workflow, run, job, and artifact reads.",
      defaultEnabled: false,
      tools: [
        {
          name: "actions_get",
          description: "Get details for one GitHub Actions resource.",
          inputSchema: objectSchema({
            method: stringSchema(),
            owner: stringSchema(),
            repo: stringSchema(),
            resource_id: stringSchema(),
          }, ["method", "owner", "repo", "resource_id"]),
          readOnly: true,
          riskClass: "read",
          repositoryScoped: true,
          requiresApproval: false,
        },
        {
          name: "actions_list",
          description: "List bounded GitHub Actions resources.",
          inputSchema: objectSchema({
            method: stringSchema(),
            owner: stringSchema(),
            repo: stringSchema(),
            resource_id: stringSchema(),
            page: integerSchema(1),
            per_page: integerSchema(1, 100),
          }, ["method", "owner", "repo"]),
          readOnly: true,
          riskClass: "read",
          repositoryScoped: true,
          requiresApproval: false,
        },
      ],
    },
  ],
});

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value) as T;
}

function toolMap(catalogue: GitHubToolCatalogue): Map<string, GitHubToolDefinition> {
  return new Map(
    catalogue.toolsets.flatMap((toolset) => toolset.tools)
      .map((tool) => [tool.name, tool] as const),
  );
}

function toolScore(
  tool: GitHubToolDefinition,
  query: string,
  tokens: string[],
): number {
  const name = tool.name.toLocaleLowerCase("en-US");
  const description = tool.description.toLocaleLowerCase("en-US");
  let score = name === query ? 1000 : name.startsWith(query) ? 600 : name.includes(query) ? 350 : 0;
  if (description.includes(query)) score += 180;
  for (const token of tokens) {
    if (name === token) score += 160;
    else if (name.includes(token)) score += 80;
    if (description.includes(token)) score += 30;
    if (tool.toolset.includes(token)) score += 20;
  }
  return score;
}

function catalogueName(value: string, label: string, pattern: RegExp): string {
  const name = boundedText(value, label, 128).toLocaleLowerCase("en-US");
  if (!pattern.test(name)) throw new RangeError(`${label} is invalid`);
  return name;
}

function riskValue(value: string, toolName: string): GitHubToolRiskClass {
  if ((githubToolRiskClasses as readonly string[]).includes(value)) {
    return value as GitHubToolRiskClass;
  }
  throw new RangeError(`GitHub tool ${toolName} risk class is invalid`);
}

function booleanValue(value: boolean, label: string): boolean {
  if (typeof value !== "boolean") throw new RangeError(`${label} must be boolean`);
  return value;
}

function canonicalObject(value: unknown, label: string): Record<string, unknown> {
  const canonical = JSON.parse(stableJson(value)) as unknown;
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
    throw new RangeError(`${label} must be a JSON object`);
  }
  return canonical as Record<string, unknown>;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(values?: string[]): Record<string, unknown> {
  return values ? { type: "string", enum: values } : { type: "string" };
}

function integerSchema(minimum: number, maximum?: number): Record<string, unknown> {
  return {
    type: "integer",
    minimum,
    ...(maximum === undefined ? {} : { maximum }),
  };
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
