import { createHash } from "node:crypto";
import {
  callsignCollisionKey,
  callsignPools,
} from "./callsign-suggestions.js";

export const callsignBootstrapCategories = [
  "animal",
  "food",
  "object",
  "concept",
  "nature",
  "science",
  "sport",
  "verb",
  "word",
  "internet",
  "myth",
  "gibberish",
  "literary",
  "language",
] as const;

export type CallsignBootstrapCategory = typeof callsignBootstrapCategories[number];

const supplementalPools: Readonly<Record<
  Exclude<CallsignBootstrapCategory, "animal" | "object" | "internet" | "literary">,
  readonly string[]
>> = {
  food: [
    "Bagel",
    "Biscuit",
    "Churro",
    "Crumpet",
    "Dumpling",
    "Falafel",
    "Gnocchi",
    "Kimchi",
    "Marmalade",
    "Mochi",
    "Noodle",
    "Pesto",
    "Pickle",
    "Pierogi",
    "Pretzel",
    "Samosa",
    "Sesame",
    "Sorbet",
    "Taffy",
    "Tofu",
    "Truffle",
    "Turnip",
    "Udon",
    "Waffle",
  ],
  concept: [
    "Balance",
    "Chance",
    "Context",
    "Contrast",
    "Entropy",
    "Horizon",
    "Interval",
    "Latency",
    "Loop",
    "Margin",
    "Memory",
    "Momentum",
    "Paradox",
    "Parity",
    "Pattern",
    "Proof",
    "Riddle",
    "Serendipity",
    "Signal",
    "Symmetry",
    "Threshold",
    "Variance",
    "VectorField",
    "Wonder",
  ],
  nature: [
    "Acorn",
    "Bramble",
    "Brook",
    "Canyon",
    "Clover",
    "Dewdrop",
    "Driftwood",
    "Dune",
    "Fjord",
    "Flint",
    "Glacier",
    "Hailstone",
    "Lichen",
    "Meadow",
    "Moss",
    "Pebble",
    "Pollen",
    "Reed",
    "Spruce",
    "Thistle",
    "Tide",
    "Willow",
    "Zephyr",
    "Zinnia",
  ],
  science: [
    "Ampere",
    "Boson",
    "Eclipse",
    "Fractal",
    "Helix",
    "Hertz",
    "Isotope",
    "Kelvin",
    "Lattice",
    "Matrix",
    "Muon",
    "Neutrino",
    "Nova",
    "Orbit",
    "Pascal",
    "Photon",
    "Plasma",
    "Prism",
    "Proton",
    "Pulsar",
    "Quasar",
    "Scalar",
    "Tensor",
    "Vector",
  ],
  sport: [
    "Breakaway",
    "Bunt",
    "Cleat",
    "Corner",
    "Derby",
    "Dribble",
    "Freestyle",
    "Goalie",
    "HatTrick",
    "Hurdle",
    "Javelin",
    "Peloton",
    "Pinfall",
    "Rally",
    "Scrum",
    "Serve",
    "Shuttle",
    "Slalom",
    "Sprint",
    "Sweep",
    "Tee",
    "Volley",
    "Wicket",
    "Yardline",
  ],
  verb: [
    "Blink",
    "Bounce",
    "Doodle",
    "Drift",
    "Fidget",
    "Juggle",
    "Mingle",
    "Nudge",
    "Ponder",
    "Rummage",
    "Scoot",
    "Shuffle",
    "Skim",
    "Sprout",
    "Swoop",
    "Tinker",
    "Toggle",
    "Tumble",
    "Twirl",
    "Wander",
    "Whittle",
    "Wobble",
    "Zip",
    "Zoom",
  ],
  word: [
    "Cadence",
    "Fable",
    "Fathom",
    "Glyph",
    "Hush",
    "Jot",
    "Kerfuffle",
    "Lilt",
    "Morsel",
    "Murmur",
    "Nook",
    "Palimpsest",
    "Pith",
    "Quirk",
    "Riff",
    "Scribble",
    "Tittle",
    "Thrum",
    "Tonic",
    "Vellum",
    "Whimsy",
    "Widdershins",
    "Yonder",
    "Zigzag",
  ],
  myth: [
    "Banshee",
    "Basilisk",
    "Brownie",
    "Chimera",
    "Dryad",
    "Griffin",
    "Hydra",
    "Kappa",
    "Kelpie",
    "Kitsune",
    "Kraken",
    "Manticore",
    "Minotaur",
    "Nereid",
    "Pegasus",
    "Phoenix",
    "Pooka",
    "Roc",
    "Satyr",
    "Selkie",
    "Simurgh",
    "Sphinx",
    "Tengu",
    "Wyvern",
  ],
  gibberish: [
    "Bimble",
    "Bloop",
    "Boop",
    "Dingle",
    "Floof",
    "Fronk",
    "Jibbit",
    "Kloop",
    "Mip",
    "Nerp",
    "Plip",
    "Plonk",
    "Quibble",
    "Quonk",
    "Snerf",
    "Snorf",
    "Sproing",
    "Wibble",
    "Womp",
    "Wump",
    "Zibble",
    "Zoodle",
    "Zorp",
    "Zuzu",
  ],
  language: [
    "Amai",
    "Brisa",
    "Chispa",
    "Ciel",
    "Etoile",
    "Hoshi",
    "Hygge",
    "Kefi",
    "Kumo",
    "Lagom",
    "Lumi",
    "Lune",
    "Mizu",
    "Mond",
    "Nami",
    "Nuage",
    "Nube",
    "Sisu",
    "Skog",
    "Soleil",
    "Stern",
    "Vento",
    "Wolke",
    "Yuki",
  ],
} as const;

const maximumCandidates = 32;
const maximumAvoidEntries = 1_000;
const maximumSeedLength = 1_024;

export interface CallsignBootstrapCandidate {
  callsign: string;
  collisionKey: string;
  category: CallsignBootstrapCategory;
}

export interface CallsignBootstrapResult {
  version: 1;
  category: CallsignBootstrapCategory | "any";
  candidates: CallsignBootstrapCandidate[];
  reservesCallsign: false;
  grantsIdentityContinuity: false;
  grantsAuthority: false;
}

/**
 * Produces a deterministic, diverse preference order for machine-selected
 * callsigns. This is selection input only: the hosted lease/enrolment mutation
 * remains the sole collision and current-holder authority.
 */
export function callsignBootstrapCandidates(input: {
  seed: string;
  category?: CallsignBootstrapCategory;
  avoid?: readonly string[];
  count?: number;
}): CallsignBootstrapResult {
  const seed = boundedSeed(input.seed);
  const count = boundedCount(input.count ?? 12);
  const avoided = canonicalAvoidSet(input.avoid ?? []);
  const category = input.category ?? "any";
  const entries = category === "any"
    ? callsignBootstrapCategories.flatMap((candidateCategory) =>
      poolForCategory(candidateCategory).map((callsign) => ({
        callsign,
        category: candidateCategory,
      }))
    )
    : poolForCategory(category).map((callsign) => ({ callsign, category }));

  const unique = new Map<string, { callsign: string; category: CallsignBootstrapCategory }>();
  for (const entry of entries) {
    const collisionKey = callsignCollisionKey(entry.callsign);
    if (avoided.has(collisionKey) || unique.has(collisionKey)) continue;
    unique.set(collisionKey, entry);
  }

  const candidates = [...unique.entries()]
    .sort(([leftKey], [rightKey]) => {
      const leftScore = deterministicScore(seed, leftKey);
      const rightScore = deterministicScore(seed, rightKey);
      if (leftScore < rightScore) return -1;
      if (leftScore > rightScore) return 1;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .slice(0, count)
    .map(([collisionKey, entry]) => ({
      callsign: entry.callsign,
      collisionKey,
      category: entry.category,
    }));

  if (candidates.length === 0) {
    throw new RangeError("No callsign bootstrap candidates remain after exclusions");
  }

  return {
    version: 1,
    category,
    candidates,
    reservesCallsign: false,
    grantsIdentityContinuity: false,
    grantsAuthority: false,
  };
}

export function isCallsignBootstrapCategory(value: string): value is CallsignBootstrapCategory {
  return callsignBootstrapCategories.includes(value as CallsignBootstrapCategory);
}

function poolForCategory(category: CallsignBootstrapCategory): readonly string[] {
  switch (category) {
    case "animal":
    case "object":
    case "internet":
    case "literary":
      return callsignPools[category];
    default:
      return supplementalPools[category];
  }
}

function canonicalAvoidSet(values: readonly string[]): Set<string> {
  if (!Array.isArray(values) || values.length > maximumAvoidEntries) {
    throw new RangeError(`Callsign avoid list must contain at most ${maximumAvoidEntries} entries`);
  }
  return new Set(values.map(callsignCollisionKey));
}

function boundedCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximumCandidates) {
    throw new RangeError(`Callsign candidate count must be an integer from 1 to ${maximumCandidates}`);
  }
  return value;
}

function boundedSeed(value: string): string {
  if (typeof value !== "string") throw new RangeError("Callsign bootstrap seed must be text");
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || [...normalized].length > maximumSeedLength) {
    throw new RangeError(`Callsign bootstrap seed must be 1 to ${maximumSeedLength} characters`);
  }
  return normalized;
}

function deterministicScore(seed: string, collisionKey: string): string {
  return createHash("sha256")
    .update("stensibly-callsign-bootstrap/v1")
    .update("\0")
    .update(seed)
    .update("\0")
    .update(collisionKey)
    .digest("hex");
}
