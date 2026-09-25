import { createHash, randomBytes } from "node:crypto";
import { callsignCollisionKey, canonicalCallsignDisplay } from "./callsign-derivation.js";
import { callsignSigil } from "./callsign-sigils.js";
import {
  defaultNamegenVibe,
  namegenVibePools,
  namegenVibes,
  type NamegenVibe,
} from "./callsign-namegen-pool.js";

export { defaultNamegenVibe, namegenVibePools, namegenVibes, type NamegenVibe };

/**
 * Proposes callsigns that are easy to say, easy to tell apart at a glance, and
 * clear of every name the caller reports as taken, including near-collisions
 * the registrar's exact collision key would accept (`SlateHarrow` beside
 * `SlateHarrier`).
 *
 * Namegen proposes and derives only. It reserves nothing: the registrar owns
 * leases, generations, and receipts, and a callsign is attribution, never
 * authority.
 */

export const namegenVersion = 1;

const minimumGeneratedLength = 4;
const maximumGeneratedLength = 10;
const minimumReadableLength = 3;
const maximumReadableLength = 12;
const maximumProposals = 20;
const maximumTakenEntries = 5_000;
const maximumSeedLength = 1_024;
const sharedPrefixLimit = 5;
const sharedPrefixShare = 0.7;

/**
 * Names that read as a role, an authority, or a model/vendor identity. A
 * callsign distinguishes worker sessions; it must never look like permission.
 */
const authorityTokens = [
  "admin",
  "anthropic",
  "approv",
  "authority",
  "captain",
  "chatgpt",
  "claude",
  "codex",
  "commander",
  "copilot",
  "gemini",
  "maintainer",
  "moderator",
  "official",
  "openai",
  "operator",
  "owner",
  "reviewer",
  "security",
  "staff",
  "sudo",
  "superuser",
  "system",
  "verified",
] as const;
const authorityExactKeys = new Set([
  "bot",
  "boss",
  "chief",
  "general",
  "gpt",
  "lead",
  "manager",
  "marshal",
  "root",
  "sheriff",
  "warden",
]);

export type NamegenConflictKind = "exact" | "visual" | "phonetic" | "prefix" | "edit";

export interface NamegenConflict {
  kind: NamegenConflictKind;
  callsign: string;
}

export type NamegenIssueKind =
  | "length"
  | "separators"
  | "digits"
  | "pronounceability"
  | "authority";

export interface NamegenIssue {
  kind: NamegenIssueKind;
  detail: string;
}

export interface NamegenProposal {
  callsign: string;
  collisionKey: string;
  sigil: string;
  sigilSource: "override" | "derived";
  tier: "curated" | "coined";
  /** Pool the name came from; differs from the requested vibe once that pool runs dry. */
  vibe: NamegenVibe;
  /**
   * True when every pool was exhausted under the full rules and this name is
   * only clear of same-word matches (exact, look-alike, sound-alike).
   */
  nearCollisionRulesRelaxed: boolean;
  sigilSharedWithActiveLease: boolean;
}

export interface NamegenProposalOptions {
  /** Explicit replay seed. Takes precedence over run and session. */
  seed?: string;
  /** Run and session seed the order, so one worker replays the same proposals. */
  run?: string;
  session?: string;
  /**
   * Names a reader may see beside the proposal (active leases, recent
   * history): proposals avoid every kind of confusion with these.
   */
  taken?: readonly string[];
  /**
   * Older history: proposals only avoid names that are the same word to a
   * reader (exact, visual, phonetic), so the pool is not consumed by rhymes and
   * shared prefixes of names nobody is showing any more.
   */
  history?: readonly string[];
  /** Sigils held by active leases; proposals prefer a sigil nobody is showing. */
  activeSigils?: readonly string[];
  count?: number;
  /** Word pool to draw from; defaults to `defaultNamegenVibe`. Never changes sigils or keys. */
  vibe?: NamegenVibe;
}

export interface NamegenProposalResult {
  version: typeof namegenVersion;
  vibe: NamegenVibe;
  seedSource: "explicit" | "run-session" | "random";
  seedFingerprint: string;
  proposals: NamegenProposal[];
  reservesCallsign: false;
  grantsIdentityContinuity: false;
  grantsAuthority: false;
}

export interface NamegenAssessment {
  callsign: string;
  collisionKey: string;
  sigil: string;
  sigilSource: "override" | "derived";
  issues: NamegenIssue[];
  conflicts: NamegenConflict[];
}

/**
 * Deterministic proposals: the same seed (or run + session) and the same taken
 * set always yield the same names, independent of taken-list order.
 */
export function proposeCallsigns(options: NamegenProposalOptions = {}): NamegenProposalResult {
  const count = boundedInteger(options.count ?? 1, 1, maximumProposals, "Proposal count");
  const { seed, seedSource } = resolveSeed(options);
  const taken = takenIndex(options.taken ?? []);
  const history = strongIndex(takenIndex(options.history ?? []));
  const activeSigils = new Set(options.activeSigils ?? []);

  const vibe = resolveVibe(options.vibe);

  const chosen: NamegenProposal[] = [];
  const chosenKeys: ComparisonKeys[] = [];
  const deferred: Array<{ proposal: NamegenProposal; keys: ComparisonKeys }> = [];
  const chosenSigils = new Set<string>();

  const takenStrong = strongIndex(taken);
  const chosenSet = new Set<string>();
  let relaxed = false;

  const consider = (
    callsign: string,
    source: { vibe: NamegenVibe; tier: NamegenProposal["tier"] },
  ): boolean => {
    const key = callsignCollisionKey(callsign);
    if (chosenSet.has(key)) return false;
    const keys = comparisonKeys(key);
    if (strongConflict(keys, history) !== null) return false;
    if (relaxed) {
      if (strongConflict(keys, takenStrong) !== null) return false;
      if (strongConflict(keys, strongIndex(chosenKeys.map((entry) => ({ ...entry, callsign: entry.key })))) !== null) {
        return false;
      }
    } else {
      if (firstConflict(keys, taken) !== null) return false;
      if (firstConflict(keys, chosenKeys) !== null) return false;
      if (deferred.some((entry) => entry.keys.key === key)) return false;
    }
    const derived = callsignSigil(callsign);
    const proposal: NamegenProposal = {
      callsign: derived.callsign,
      collisionKey: key,
      sigil: derived.sigil,
      sigilSource: derived.source,
      tier: source.tier,
      vibe: source.vibe,
      nearCollisionRulesRelaxed: relaxed,
      sigilSharedWithActiveLease: activeSigils.has(derived.sigil),
    };
    if (relaxed) {
      chosen.push(proposal);
      chosenKeys.push(keys);
      chosenSet.add(key);
      return chosen.length === count;
    }
    if (activeSigils.has(proposal.sigil) || chosenSigils.has(proposal.sigil)) {
      deferred.push({ proposal, keys });
      return false;
    }
    chosen.push(proposal);
    chosenKeys.push(keys);
    chosenSet.add(key);
    chosenSigils.add(proposal.sigil);
    return chosen.length === count;
  };

  // The requested vibe first; when it runs dry, route on to the other pools
  // rather than fail, curated words before coined ones.
  const vibeOrder = [vibe, ...namegenVibes.filter((entry) => entry !== vibe)];
  const sources = vibeOrder.flatMap((entry) => [
    { vibe: entry, tier: "curated" as const, names: () => seededOrder(namegenVibePools[entry].curated, seed, `${entry}:curated`) },
    { vibe: entry, tier: "coined" as const, names: () => seededOrder(coinedCallsigns(entry), seed, `${entry}:coined`) },
  ]);
  const drain = (): boolean => {
    for (const source of sources) {
      for (const callsign of source.names()) {
        if (consider(callsign, source)) return true;
      }
    }
    return false;
  };

  drain();
  // Every distinct sigil is in use: fall back to distinct names that share one.
  for (const next of deferred) {
    if (chosen.length === count) break;
    if (firstConflict(next.keys, chosenKeys) !== null) continue;
    chosen.push(next.proposal);
    chosenKeys.push(next.keys);
    chosenSet.add(next.keys.key);
  }
  // Every pool is exhausted under the full rules: keep going with names that
  // are only clear of same-word matches, and say so on the proposal.
  if (chosen.length < count) {
    relaxed = true;
    drain();
  }
  if (chosen.length < count) {
    throw new RangeError("Every callsign in every vibe is already taken");
  }

  return {
    version: namegenVersion,
    vibe,
    seedSource,
    seedFingerprint: `sha256:${createHash("sha256").update(seed).digest("hex")}`,
    proposals: chosen,
    reservesCallsign: false,
    grantsIdentityContinuity: false,
    grantsAuthority: false,
  };
}

/**
 * Explains why a caller-chosen name would be hard to read or would be confused
 * with a taken one. Throws only when the registrar would reject the text.
 */
export function assessCallsign(
  callsign: string,
  taken: readonly string[] = [],
  history: readonly string[] = [],
): NamegenAssessment {
  const display = canonicalCallsignDisplay(callsign);
  const key = callsignCollisionKey(display);
  const derived = callsignSigil(display);
  const conflicts: NamegenConflict[] = [];
  const seen = new Set<string>();
  for (const [index, strength] of [[takenIndex(taken), "any"], [takenIndex(history), "strong"]] as const) {
    for (const entry of index) {
      if (seen.has(entry.key)) continue;
      const kind = conflictKind(key, entry.key);
      if (kind !== null && (strength === "any" || strongConflictKinds.has(kind))) {
        seen.add(entry.key);
        conflicts.push({ kind, callsign: entry.callsign });
      }
    }
  }
  conflicts.sort((left, right) =>
    conflictRank(left.kind) - conflictRank(right.kind)
    || compareText(left.callsign, right.callsign)
  );

  return {
    callsign: display,
    collisionKey: key,
    sigil: derived.sigil,
    sigilSource: derived.source,
    issues: callsignQualityIssues(display),
    conflicts,
  };
}

/** Readability problems with a name on its own, independent of the registry. */
export function callsignQualityIssues(callsign: string): NamegenIssue[] {
  const display = canonicalCallsignDisplay(callsign);
  const key = callsignCollisionKey(display);
  const issues: NamegenIssue[] = [];
  if (key.length < minimumReadableLength || key.length > maximumReadableLength) {
    issues.push({
      kind: "length",
      detail: `${key.length} characters; keep between ${minimumReadableLength} and ${maximumReadableLength}`,
    });
  }
  if (/[ _-]/u.test(display)) {
    issues.push({
      kind: "separators",
      detail: "spaces, hyphens and underscores do not distinguish names, so they only add ways to misspell it",
    });
  }
  if (/[0-9]/u.test(key)) {
    issues.push({ kind: "digits", detail: "digits read as version numbers or generations" });
  }
  for (const detail of pronounceabilityProblems(key)) {
    issues.push({ kind: "pronounceability", detail });
  }
  const authority = authorityToken(key);
  if (authority !== null) {
    issues.push({
      kind: "authority",
      detail: `"${authority}" reads as a role, authority, or model identity; a callsign grants none`,
    });
  }
  return issues;
}

/**
 * How two collision keys would be confused, strongest first, or null when a
 * reader can tell them apart.
 */
export function conflictKind(left: string, right: string): NamegenConflictKind | null {
  return conflictBetween(comparisonKeys(left), comparisonKeys(right));
}

interface ComparisonKeys {
  key: string;
  visual: string;
  phonetic: string;
}

const comparisonKeyCache = new Map<string, ComparisonKeys>();

function comparisonKeys(key: string): ComparisonKeys {
  const cached = comparisonKeyCache.get(key);
  if (cached !== undefined) return cached;
  const keys = { key, visual: visualKey(key), phonetic: callsignPhoneticKey(key) };
  // Pools are fixed and bounded; the cap keeps caller-supplied names from growing it forever.
  if (comparisonKeyCache.size < 20_000) comparisonKeyCache.set(key, keys);
  return keys;
}

function conflictBetween(leftKeys: ComparisonKeys, rightKeys: ComparisonKeys): NamegenConflictKind | null {
  const left = leftKeys.key;
  const right = rightKeys.key;
  if (left === right) return "exact";
  if (leftKeys.visual === rightKeys.visual) return "visual";
  if (leftKeys.phonetic === rightKeys.phonetic) return "phonetic";
  // Readers skim the start of a name, so a long shared opening confuses
  // (SlateHarrow, SlateHarrier). A shared head with a different tail
  // (Honeyjam, Honeybun) stays readable.
  const shared = sharedPrefixLength(left, right);
  if (shared >= sharedPrefixLimit && shared >= sharedPrefixShare * Math.min(left.length, right.length)) {
    return "prefix";
  }
  const budget = editBudget(Math.min(left.length, right.length));
  if (Math.abs(left.length - right.length) <= budget && editDistance(left, right) <= budget) return "edit";
  return null;
}

/**
 * A coarse sound-alike key: spelling variants that are said the same way
 * (`Quillmoor`, `Kwilmoor`; `Wren`, `Ren`) share it.
 */
export function callsignPhoneticKey(collisionKey: string): string {
  let value = collisionKey.toLowerCase().replace(/[^a-z0-9]/gu, "");
  value = value
    .replace(/^kn/u, "n")
    .replace(/^gn/u, "n")
    .replace(/^wr/u, "r")
    .replace(/^ps/u, "s")
    .replace(/^x/u, "s")
    .replace(/tch/gu, "ch")
    .replace(/sch/gu, "sk")
    .replace(/ch/gu, "C")
    .replace(/sh/gu, "S")
    .replace(/th/gu, "T")
    .replace(/ph/gu, "f")
    .replace(/wh/gu, "w")
    .replace(/ck/gu, "k")
    .replace(/qu/gu, "kw")
    .replace(/q/gu, "k")
    .replace(/dg(?=[eiy])/gu, "j")
    .replace(/c(?=[eiy])/gu, "s")
    .replace(/c/gu, "k")
    .replace(/x/gu, "ks")
    .replace(/z/gu, "s")
    .replace(/gh(?![aeiouy])/gu, "");
  if (value.length > 3) value = value.replace(/([^aeiouy])e$/u, "$1");
  value = value.replace(/(.)\1+/gu, "$1");
  value = value.replace(/[aeiouy]+/gu, (run) => run[0] === "y" ? "i" : run[0] ?? "");
  return value;
}

const coinedCache = new Map<NamegenVibe, readonly string[]>();

export function coinedCallsigns(vibe: NamegenVibe = defaultNamegenVibe): readonly string[] {
  const cached = coinedCache.get(vibe);
  if (cached !== undefined) return cached;
  const names: string[] = [];
  const pool = namegenVibePools[resolveVibe(vibe)];
  for (const head of pool.coinedHeads) {
    for (const tail of pool.coinedTails) {
      const name = `${head}${tail}`;
      const key = name.toLowerCase();
      // The seam must stay audible: no doubled letter (Ashhawk) and no vowel
      // running into a vowel (Tidearrow).
      const last = head.slice(-1).toLowerCase();
      const first = tail.slice(0, 1).toLowerCase();
      if (last === first || (/[aeiouy]/u.test(last) && /[aeiou]/u.test(first))) continue;
      if (key.length < minimumGeneratedLength || key.length > maximumGeneratedLength) continue;
      if (pronounceabilityProblems(key).length > 0) continue;
      if (authorityToken(key) !== null) continue;
      names.push(name);
    }
  }
  coinedCache.set(vibe, names);
  return names;
}

export function pronounceabilityProblems(collisionKey: string): string[] {
  const problems: string[] = [];
  const letters = collisionKey.replace(/[^a-z]/gu, "");
  if (!/[aeiouy]/u.test(letters)) problems.push("no vowel");
  const consonantRun = longestRun(letters, /[^aeiouy]/u);
  if (consonantRun > 3) problems.push(`${consonantRun} consonants in a row`);
  const vowelRun = longestRun(letters, /[aeiou]/u);
  if (vowelRun > 2) problems.push(`${vowelRun} vowels in a row`);
  if (/(.)\1\1/u.test(letters)) problems.push("a letter tripled");
  const syllables = syllableEstimate(letters);
  if (syllables > 4) problems.push(`about ${syllables} syllables; keep to 4`);
  return problems;
}

function syllableEstimate(letters: string): number {
  const groups = letters.match(/[aeiouy]+/gu)?.length ?? 0;
  const silentE = letters.length > 3 && /[^aeiouy]e$/u.test(letters) && !/[^aeiouy]le$/u.test(letters);
  return Math.max(1, groups - (silentE ? 1 : 0));
}

function longestRun(value: string, pattern: RegExp): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    current = pattern.test(character) ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function authorityToken(collisionKey: string): string | null {
  if (authorityExactKeys.has(collisionKey)) return collisionKey;
  return authorityTokens.find((token) => collisionKey.includes(token)) ?? null;
}

/** Letter shapes that blur at a glance in proportional fonts. */
function visualKey(collisionKey: string): string {
  return collisionKey
    .replace(/rn/gu, "m")
    .replace(/vv/gu, "w")
    .replace(/cl/gu, "d")
    .replace(/[1i]/gu, "l")
    .replace(/0/gu, "o");
}

function sharedPrefixLength(left: string, right: string): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
}

function editBudget(shorterLength: number): number {
  if (shorterLength <= 5) return 1;
  if (shorterLength <= 8) return 2;
  return 3;
}

/** Optimal string alignment distance: insert, delete, substitute, transpose. */
function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
  for (let row = 0; row < rows; row += 1) table[row]![0] = row;
  for (let column = 0; column < columns; column += 1) table[0]![column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(
        table[row - 1]![column]! + 1,
        table[row]![column - 1]! + 1,
        table[row - 1]![column - 1]! + cost,
      );
      if (
        row > 1 && column > 1
        && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]
      ) {
        best = Math.min(best, table[row - 2]![column - 2]! + 1);
      }
      table[row]![column] = best;
    }
  }
  return table[left.length]![right.length]!;
}

interface TakenEntry extends ComparisonKeys {
  callsign: string;
}

function takenIndex(values: readonly string[]): TakenEntry[] {
  if (!Array.isArray(values) || values.length > maximumTakenEntries) {
    throw new RangeError(`Taken names must be a list of at most ${maximumTakenEntries} entries`);
  }
  const byKey = new Map<string, TakenEntry>();
  for (const value of values) {
    let callsign: string;
    try {
      callsign = canonicalCallsignDisplay(value);
    } catch (error) {
      throw new RangeError(`Taken name ${JSON.stringify(value)} is not a valid callsign: ${(error as Error).message}`);
    }
    const key = callsignCollisionKey(callsign);
    const existing = byKey.get(key);
    if (!existing || compareText(callsign, existing.callsign) < 0) {
      byKey.set(key, { callsign, ...comparisonKeys(key) });
    }
  }
  return [...byKey.values()].sort((left, right) => compareText(left.key, right.key));
}

const strongConflictKinds: ReadonlySet<NamegenConflictKind> = new Set(["exact", "visual", "phonetic"]);

interface StrongIndex {
  exact: ReadonlyMap<string, string>;
  visual: ReadonlyMap<string, string>;
  phonetic: ReadonlyMap<string, string>;
}

/** Hash lookups for the same-word checks, so long history stays cheap. */
function strongIndex(entries: readonly TakenEntry[]): StrongIndex {
  const exact = new Map<string, string>();
  const visual = new Map<string, string>();
  const phonetic = new Map<string, string>();
  for (const entry of entries) {
    exact.set(entry.key, entry.callsign);
    if (!visual.has(entry.visual)) visual.set(entry.visual, entry.callsign);
    if (!phonetic.has(entry.phonetic)) phonetic.set(entry.phonetic, entry.callsign);
  }
  return { exact, visual, phonetic };
}

function strongConflict(keys: ComparisonKeys, index: StrongIndex): NamegenConflict | null {
  const exact = index.exact.get(keys.key);
  if (exact !== undefined) return { kind: "exact", callsign: exact };
  const visual = index.visual.get(keys.visual);
  if (visual !== undefined) return { kind: "visual", callsign: visual };
  const phonetic = index.phonetic.get(keys.phonetic);
  if (phonetic !== undefined) return { kind: "phonetic", callsign: phonetic };
  return null;
}

function firstConflict(
  keys: ComparisonKeys,
  taken: readonly (ComparisonKeys & { callsign?: string })[],
): NamegenConflict | null {
  for (const entry of taken) {
    const kind = conflictBetween(keys, entry);
    if (kind !== null) return { kind, callsign: entry.callsign ?? entry.key };
  }
  return null;
}

function conflictRank(kind: NamegenConflictKind): number {
  return ["exact", "visual", "phonetic", "prefix", "edit"].indexOf(kind);
}

export function resolveVibe(value: string | undefined): NamegenVibe {
  if (value === undefined) return defaultNamegenVibe;
  const normalized = value.trim().toLowerCase();
  const vibe = namegenVibes.find((entry) => entry === normalized);
  if (vibe === undefined) {
    throw new RangeError(`Unknown vibe ${JSON.stringify(value)}; choose one of: ${namegenVibes.join(", ")}`);
  }
  return vibe;
}

function resolveSeed(options: NamegenProposalOptions): {
  seed: string;
  seedSource: NamegenProposalResult["seedSource"];
} {
  if (options.seed !== undefined) return { seed: boundedSeed(options.seed), seedSource: "explicit" };
  if (options.run !== undefined || options.session !== undefined) {
    return {
      seed: boundedSeed(`run:${options.run ?? ""}\0session:${options.session ?? ""}`),
      seedSource: "run-session",
    };
  }
  return { seed: randomBytes(32).toString("hex"), seedSource: "random" };
}

function boundedSeed(value: string): string {
  if (typeof value !== "string") throw new RangeError("Namegen seed must be text");
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || [...normalized].length > maximumSeedLength) {
    throw new RangeError(`Namegen seed must be 1 to ${maximumSeedLength} characters`);
  }
  return normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

/**
 * Deterministic shuffle. The seed and namespace are hashed once with SHA-256;
 * each value is then scored with a fast 53-bit hash of (seed digest, value),
 * which is plenty for ordering and keeps a proposal cheap over large pools.
 */
function seededOrder(values: readonly string[], seed: string, namespace: string): string[] {
  const prefix = createHash("sha256")
    .update(`stensibly-callsign-namegen/v${namegenVersion}`)
    .update("\0")
    .update(seed)
    .update("\0")
    .update(namespace)
    .digest("hex");
  const scored = values.map((value) => ({ value, score: orderingHash(`${prefix}\0${value}`) }));
  scored.sort((left, right) => left.score - right.score || compareText(left.value, right.value));
  return scored.map((entry) => entry.value);
}

/** cyrb53: a small, well-mixed 53-bit string hash. Not for security. */
function orderingHash(value: string): number {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return 4294967296 * (2097151 & second) + (first >>> 0);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
