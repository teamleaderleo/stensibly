import {
  githubCapabilityRegistry,
  githubCapabilitySkills,
  githubCapabilityTiers,
  type GitHubCapabilityDefinition,
  type GitHubCapabilityRegistry,
  type GitHubCapabilitySkill,
  type GitHubCapabilityTier,
} from "./github-capability-curation.js";
import { boundedText } from "./github-provider-validation.js";

export interface GitHubCapabilitySearchResult extends GitHubCapabilityDefinition {
  score: number;
}

export interface GitHubCapabilityToolsetList {
  catalogueRevision: string;
  sourceRevision: string;
  fingerprint: string;
  dispatchSurface: "typed_first_party_only";
  delegatedDispatchEnabled: false;
  visibilityPolicy: {
    defaultVisibleTiers: GitHubCapabilityTier[];
    searchableTiers: GitHubCapabilityTier[];
    hiddenTiers: GitHubCapabilityTier[];
  };
  toolsets: Array<{
    name: GitHubCapabilitySkill;
    description: string;
    defaultVisibleCount: number;
    searchableCount: number;
    totalCount: number;
    tierCounts: Record<GitHubCapabilityTier, number>;
  }>;
}

export class GitHubCapabilityCatalogueService {
  readonly registry: GitHubCapabilityRegistry;

  constructor(registry: GitHubCapabilityRegistry = githubCapabilityRegistry) {
    this.registry = registry;
  }

  listToolsets(input: {
    skills?: GitHubCapabilitySkill[];
    includeHidden?: boolean;
  } = {}): GitHubCapabilityToolsetList {
    const skills = normalizeSkills(input.skills);
    const includeHidden = input.includeHidden ?? false;
    if (typeof includeHidden !== "boolean") {
      throw new RangeError("GitHub hidden-capability flag must be boolean");
    }
    const selected = this.registry.skills
      .filter((toolset) => skills === null || skills.has(toolset.name))
      .map((toolset) => ({
        ...toolset,
        totalCount: includeHidden ? toolset.totalCount : toolset.searchableCount,
        tierCounts: Object.fromEntries(
          githubCapabilityTiers.map((tier) => [
            tier,
            includeHidden || tier === "essential" || tier === "secondary" || tier === "advanced"
              ? toolset.tierCounts[tier]
              : 0,
          ]),
        ) as Record<GitHubCapabilityTier, number>,
      }));
    return {
      catalogueRevision: this.registry.curationRevision,
      sourceRevision: this.registry.sourceRevision,
      fingerprint: this.registry.fingerprint,
      dispatchSurface: "typed_first_party_only",
      delegatedDispatchEnabled: false,
      visibilityPolicy: {
        defaultVisibleTiers: ["essential"],
        searchableTiers: ["essential", "secondary", "advanced"],
        hiddenTiers: ["internal", "excluded"],
      },
      toolsets: selected,
    };
  }

  searchTools(input: {
    query: string;
    skills?: GitHubCapabilitySkill[];
    tiers?: GitHubCapabilityTier[];
    readOnly?: boolean;
    includeHidden?: boolean;
    limit?: number;
  }): GitHubCapabilitySearchResult[] {
    const query = boundedText(input.query, "GitHub capability search query", 200)
      .toLocaleLowerCase("en-US");
    const skills = normalizeSkills(input.skills);
    const tiers = normalizeTiers(input.tiers);
    const includeHidden = input.includeHidden ?? false;
    if (typeof includeHidden !== "boolean") {
      throw new RangeError("GitHub hidden-capability flag must be boolean");
    }
    if (input.readOnly !== undefined && typeof input.readOnly !== "boolean") {
      throw new RangeError("GitHub capability read-only filter must be boolean");
    }
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("GitHub capability search limit must be between 1 and 100");
    }
    const tokens = [...new Set(query.split(/\s+/u).filter(Boolean))];
    return this.registry.capabilities
      .filter((capability) => includeHidden || capability.searchable)
      .filter((capability) => skills === null || skills.has(capability.skill))
      .filter((capability) => tiers === null || tiers.has(capability.tier))
      .filter((capability) => input.readOnly === undefined
        || capability.readOnly === input.readOnly)
      .map((capability) => ({
        ...capability,
        score: capabilityScore(capability, query, tokens),
      }))
      .filter((capability) => capability.score > 0)
      .sort((left, right) => right.score - left.score
        || tierRank(left.tier) - tierRank(right.tier)
        || codeUnitCompare(left.name, right.name))
      .slice(0, limit);
  }

  getTool(name: string): GitHubCapabilityDefinition {
    const normalized = boundedText(name, "GitHub capability name", 128)
      .toLocaleLowerCase("en-US");
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(normalized)) {
      throw new RangeError("GitHub capability name is invalid");
    }
    const capability = this.registry.capabilities.find((entry) => entry.name === normalized);
    if (!capability) throw new RangeError(`Unknown GitHub capability: ${normalized}`);
    return capability;
  }
}

function normalizeSkills(
  values: GitHubCapabilitySkill[] | undefined,
): Set<GitHubCapabilitySkill> | null {
  if (values === undefined) return null;
  if (!Array.isArray(values) || values.length > githubCapabilitySkills.length) {
    throw new RangeError("GitHub capability skill filter is invalid");
  }
  const result = new Set<GitHubCapabilitySkill>();
  for (const value of values) {
    if (!(githubCapabilitySkills as readonly string[]).includes(value)) {
      throw new RangeError(`Unknown GitHub capability skill: ${value}`);
    }
    result.add(value);
  }
  if (result.size !== values.length) {
    throw new RangeError("GitHub capability skill filters must be unique");
  }
  return result;
}

function normalizeTiers(
  values: GitHubCapabilityTier[] | undefined,
): Set<GitHubCapabilityTier> | null {
  if (values === undefined) return null;
  if (!Array.isArray(values) || values.length > githubCapabilityTiers.length) {
    throw new RangeError("GitHub capability tier filter is invalid");
  }
  const result = new Set<GitHubCapabilityTier>();
  for (const value of values) {
    if (!(githubCapabilityTiers as readonly string[]).includes(value)) {
      throw new RangeError(`Unknown GitHub capability tier: ${value}`);
    }
    result.add(value);
  }
  if (result.size !== values.length) {
    throw new RangeError("GitHub capability tier filters must be unique");
  }
  return result;
}

function capabilityScore(
  capability: GitHubCapabilityDefinition,
  query: string,
  tokens: string[],
): number {
  const name = capability.name.toLocaleLowerCase("en-US");
  const displayName = capability.displayName.toLocaleLowerCase("en-US");
  const description = capability.description.toLocaleLowerCase("en-US");
  const skill = capability.skill.replaceAll("_", " ");
  let score = name === query ? 1_000
    : name.startsWith(query) ? 600
    : name.includes(query) ? 350
    : displayName.includes(query) ? 240
    : description.includes(query) ? 180
    : skill.includes(query) ? 120
    : 0;
  for (const token of tokens) {
    if (name === token) score += 160;
    else if (name.includes(token)) score += 80;
    if (displayName.includes(token)) score += 50;
    if (description.includes(token)) score += 30;
    if (skill.includes(token)) score += 25;
    if (capability.tier === token) score += 20;
  }
  score += Math.max(0, 30 - tierRank(capability.tier) * 10);
  return score;
}

function tierRank(tier: GitHubCapabilityTier): number {
  return githubCapabilityTiers.indexOf(tier);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
