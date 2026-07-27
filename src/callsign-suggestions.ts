import { createHash, randomBytes } from "node:crypto";

export const baseCallsignCategories = [
  "animal",
  "object",
  "literary",
  "internet",
] as const;

export type BaseCallsignCategory = typeof baseCallsignCategories[number];
export type CallsignCategory = BaseCallsignCategory | "compound";

export const callsignPools: Readonly<Record<BaseCallsignCategory, readonly string[]>> = {
  animal: [
    "Albatross",
    "Axolotl",
    "Badger",
    "Capybara",
    "Cicada",
    "Cormorant",
    "Ferret",
    "Gecko",
    "Heron",
    "Ibex",
    "Kestrel",
    "Lemur",
    "Mantis",
    "Marmot",
    "Ocelot",
    "Pangolin",
    "Quokka",
    "Rook",
    "Stoat",
    "Tern",
    "Vole",
    "Wombat",
    "Yak",
    "Zebu",
  ],
  object: [
    "Anvil",
    "Apron",
    "Bellows",
    "Button",
    "Camera",
    "Compass",
    "Crayon",
    "Doorknob",
    "Easel",
    "Funnel",
    "Kettle",
    "Lantern",
    "Marbles",
    "Notebook",
    "Paperclip",
    "Plunger",
    "Postcard",
    "Teacup",
    "Thimble",
    "Toolbox",
    "Turnstile",
    "Umbrella",
    "Whistle",
    "Zipper",
  ],
  literary: [
    "Alice",
    "Beowulf",
    "Candide",
    "Cordelia",
    "Dorian",
    "Dulcinea",
    "Gulliver",
    "Horatio",
    "Ishmael",
    "Lear",
    "Merlin",
    "Nemo",
    "Odysseus",
    "Ophelia",
    "Orlando",
    "Pinocchio",
    "Prospero",
    "Puck",
    "Quixote",
    "Scheherazade",
    "Sinbad",
    "Titania",
    "Yorick",
    "Zarathustra",
  ],
  internet: [
    "Breadcrumb",
    "CacheMiss",
    "CapsLock",
    "Copypasta",
    "DebugDuck",
    "Doge",
    "Glitch",
    "Hotfix",
    "KeyboardCat",
    "LagSpike",
    "LinkRot",
    "Nyan",
    "PatchNote",
    "PingPong",
    "Pixel",
    "RubberDuck",
    "ShipIt",
    "SideQuest",
    "StackTrace",
    "TabComplete",
    "ThreadSafe",
    "Typo",
    "ViewSource",
    "WikiWalk",
  ],
} as const;

const compoundModifiers = [
  "Amber",
  "Blue",
  "Brisk",
  "Cobalt",
  "Copper",
  "Dapper",
  "Fuzzy",
  "Gentle",
  "Hidden",
  "Idle",
  "Jolly",
  "Keen",
  "Lunar",
  "Mellow",
  "Mossy",
  "Nimble",
  "Odd",
  "Paper",
  "Quiet",
  "Rusty",
  "Solar",
  "Tiny",
  "Velvet",
  "Wry",
] as const;

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const callsignDisplayPattern = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
const maximumCallsignLength = 80;
const maximumAvoidEntries = 1_000;
const maximumSuggestions = 20;
const maximumSeedLength = 256;

export interface CallsignSuggestionOptions {
  count?: number;
  seed?: string;
  avoid?: readonly string[];
  categories?: readonly BaseCallsignCategory[];
}

export interface CallsignSuggestion {
  callsign: string;
  collisionKey: string;
  category: CallsignCategory;
  source: "curated" | "compound";
}

export interface CallsignSuggestionResult {
  version: 1;
  seedSource: "explicit" | "random";
  seedFingerprint: string;
  suggestions: CallsignSuggestion[];
  reservesCallsign: false;
  grantsIdentityContinuity: false;
  grantsAuthority: false;
}

/**
 * Suggests short display callsigns from diverse local pools.
 *
 * Suggestions are presentation metadata only. They do not reserve a name, prove
 * identity continuity, enrol a worker, join a pod, or grant any authority.
 */
export function suggestCallsigns(
  options: CallsignSuggestionOptions = {},
): CallsignSuggestionResult {
  const count = boundedCount(options.count ?? 5);
  const seedSource = options.seed === undefined ? "random" : "explicit";
  const seed = options.seed === undefined
    ? randomBytes(32).toString("hex")
    : boundedSeed(options.seed);
  const avoided = canonicalAvoidSet(options.avoid ?? []);
  const categoryOrder = orderedCategories(options.categories, seed);
  const suggestions: CallsignSuggestion[] = [];
  const used = new Set(avoided);

  const shuffledPools = new Map<BaseCallsignCategory, string[]>();
  for (const category of categoryOrder) {
    shuffledPools.set(
      category,
      seededOrder(callsignPools[category], seed, `curated:${category}`),
    );
  }

  const indexes = new Map<BaseCallsignCategory, number>();
  for (const category of categoryOrder) indexes.set(category, 0);

  let madeProgress = true;
  while (suggestions.length < count && madeProgress) {
    madeProgress = false;
    for (const category of categoryOrder) {
      const pool = shuffledPools.get(category) ?? [];
      let index = indexes.get(category) ?? 0;
      while (index < pool.length) {
        const callsign = pool[index];
        index += 1;
        if (!callsign) continue;
        const collisionKey = callsignCollisionKey(callsign);
        if (used.has(collisionKey)) continue;
        used.add(collisionKey);
        suggestions.push({
          callsign,
          collisionKey,
          category,
          source: "curated",
        });
        madeProgress = true;
        break;
      }
      indexes.set(category, index);
      if (suggestions.length === count) break;
    }
  }

  if (suggestions.length < count) {
    const nouns = categoryOrder.flatMap((category) => callsignPools[category]);
    const compounds = compoundModifiers.flatMap((modifier) =>
      nouns
        .filter((noun) => modifier.toLowerCase() !== noun.toLowerCase())
        .map((noun) => `${modifier}${noun}`)
        .filter((callsign) => callsign.length <= 32)
    );
    for (const callsign of seededOrder(compounds, seed, "compound")) {
      const collisionKey = callsignCollisionKey(callsign);
      if (used.has(collisionKey)) continue;
      used.add(collisionKey);
      suggestions.push({
        callsign,
        collisionKey,
        category: "compound",
        source: "compound",
      });
      if (suggestions.length === count) break;
    }
  }

  if (suggestions.length !== count) {
    throw new RangeError("Not enough unused callsigns remain for the requested count");
  }

  return {
    version: 1,
    seedSource,
    seedFingerprint: `sha256:${createHash("sha256").update(seed).digest("hex")}`,
    suggestions,
    reservesCallsign: false,
    grantsIdentityContinuity: false,
    grantsAuthority: false,
  };
}

export function suggestCallsign(
  options: Omit<CallsignSuggestionOptions, "count"> = {},
): CallsignSuggestion {
  const suggestion = suggestCallsigns({ ...options, count: 1 }).suggestions[0];
  if (!suggestion) throw new Error("Callsign suggestion was unexpectedly empty");
  return suggestion;
}

/**
 * Returns the comparison key used for collision detection. Spacing, hyphens,
 * underscores, and ASCII case do not distinguish callsigns.
 */
export function callsignCollisionKey(value: string): string {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError("Callsign contains unsupported control characters");
  }
  const normalized = value.normalize("NFKC").trim();
  if (unsafeTextPattern.test(normalized)) {
    throw new RangeError("Callsign contains unsupported control characters");
  }
  if (normalized.length === 0) throw new RangeError("Callsign must not be empty");
  if ([...normalized].length > maximumCallsignLength) {
    throw new RangeError(`Callsign must be at most ${maximumCallsignLength} characters`);
  }
  if (!callsignDisplayPattern.test(normalized)) {
    throw new RangeError("Callsign contains unsupported characters");
  }
  const collisionKey = normalized.toLowerCase().replace(/[ _-]+/g, "");
  if (collisionKey.length === 0) throw new RangeError("Callsign must contain a letter or number");
  return collisionKey;
}

function boundedCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximumSuggestions) {
    throw new RangeError(`Callsign count must be an integer from 1 to ${maximumSuggestions}`);
  }
  return value;
}

function boundedSeed(value: string): string {
  if (typeof value !== "string" || unsafeTextPattern.test(value)) {
    throw new RangeError("Callsign seed contains unsupported control characters");
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) throw new RangeError("Callsign seed must not be empty");
  if ([...normalized].length > maximumSeedLength) {
    throw new RangeError(`Callsign seed must be at most ${maximumSeedLength} characters`);
  }
  return normalized;
}

function canonicalAvoidSet(values: readonly string[]): Set<string> {
  if (!Array.isArray(values) || values.length > maximumAvoidEntries) {
    throw new RangeError(`Callsign avoid list must contain at most ${maximumAvoidEntries} entries`);
  }
  return new Set(values.map(callsignCollisionKey));
}

function orderedCategories(
  preferred: readonly BaseCallsignCategory[] | undefined,
  seed: string,
): BaseCallsignCategory[] {
  if (preferred === undefined) {
    return seededOrder(baseCallsignCategories, seed, "category-order");
  }
  if (!Array.isArray(preferred) || preferred.length < 1 || preferred.length > baseCallsignCategories.length) {
    throw new RangeError("Callsign category preferences must contain 1 to 4 entries");
  }
  const seen = new Set<BaseCallsignCategory>();
  const ordered: BaseCallsignCategory[] = [];
  for (const rawCategory of preferred) {
    if (!baseCallsignCategories.includes(rawCategory)) {
      throw new RangeError(`Unknown callsign category: ${String(rawCategory)}`);
    }
    if (seen.has(rawCategory)) {
      throw new RangeError("Callsign category preferences contain duplicate entries");
    }
    seen.add(rawCategory);
    ordered.push(rawCategory);
  }
  const remainder = seededOrder(
    baseCallsignCategories.filter((category) => !seen.has(category)),
    seed,
    "category-remainder",
  );
  return [...ordered, ...remainder];
}

function seededOrder<T extends string>(
  values: readonly T[],
  seed: string,
  namespace: string,
): T[] {
  return [...values].sort((left, right) => {
    const leftScore = deterministicScore(seed, namespace, left);
    const rightScore = deterministicScore(seed, namespace, right);
    if (leftScore < rightScore) return -1;
    if (leftScore > rightScore) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function deterministicScore(seed: string, namespace: string, value: string): string {
  return createHash("sha256")
    .update(seed)
    .update("\0")
    .update(namespace)
    .update("\0")
    .update(value)
    .digest("hex");
}
