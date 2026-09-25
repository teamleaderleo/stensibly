/**
 * Namegen vocabulary, one pool per vibe.
 *
 * A vibe only chooses words. Sigils and collision keys come from
 * callsign-derivation.ts and callsign-sigils.ts whatever the vibe, so the
 * registrar contract never depends on it.
 *
 * Every curated name is one word of 4 to 10 letters that is easy to say,
 * carries no role or authority, and is not confusable with any other entry in
 * its pool under `conflictKind` (test/callsign-namegen.test.ts enforces this).
 * Coined names join one head and one tail and only fill in once a caller has
 * exhausted the curated pool.
 */

export const namegenVibes = ["ops", "whimsical"] as const;
export type NamegenVibe = typeof namegenVibes[number];
export const defaultNamegenVibe: NamegenVibe = "ops";

export interface NamegenVibePool {
  description: string;
  curated: readonly string[];
  coinedHeads: readonly string[];
  coinedTails: readonly string[];
}

export const namegenVibePools: Readonly<Record<NamegenVibe, NamegenVibePool>> = {
  ops: {
    description: "Short, punchy aviation and operations callsigns (Talon, Viper, Ironhawk).",
    curated: [
      "Alloy", "Anchor", "Anvil", "Apex", "Argon", "Arrow", "Aspen", "Atlas",
      "Axle", "Bandit", "Banshee", "Baron", "Barracuda", "Basalt", "Beacon", "Bison",
      "Blackjack", "Blade", "Blitz", "Blizzard", "Bolt", "Boulder", "Boxer", "Breaker",
      "Brick", "Bronco", "Bullseye", "Burner", "Cannon", "Cargo", "Charger", "Cheetah",
      "Chrome", "Cinder", "Circuit", "Clipper", "Cobalt", "Cobra", "Comet", "Corsair",
      "Cougar", "Coyote", "Crossbow", "Cruiser", "Cutlass", "Cyclone", "Dagger", "Dart",
      "Dash", "Decoy", "Diesel", "Dingo", "Domino", "Drake", "Drifter", "Dusk",
      "Dynamo", "Eagle", "Echo", "Eclipse", "Edge", "Ember", "Enigma", "Falcon",
      "Fathom", "Ferret", "Flare", "Flash", "Flicker", "Flint", "Forge", "Foxhound",
      "Freight", "Frost", "Fulcrum", "Fusion", "Gambit", "Gauntlet", "Gecko", "Geyser",
      "Ghost", "Glacier", "Glider", "Gorilla", "Granite", "Gremlin", "Grizzly", "Halo",
      "Harpoon", "Harrier", "Hatchet", "Havoc", "Hawk", "Hazard", "Helix", "Heron",
      "Hornet", "Hunter", "Hurricane", "Husky", "Hydra", "Icarus", "Iceberg", "Impulse",
      "Inferno", "Iron", "Jackal", "Javelin", "Jester", "Jigsaw", "Jinx", "Kestrel",
      "Keystone", "Kodiak", "Kraken", "Lancer", "Laser", "Lasso", "Lobo", "Lynx",
      "Mako", "Mantis", "Matrix", "Maverick", "Merlin", "Meteor", "Midnight", "Mirage",
      "Mojo", "Mongoose", "Monsoon", "Moose", "Nebula", "Neon", "Nimbus", "Nitro",
      "Nomad", "Nova", "Ocelot", "Onyx", "Orbit", "Orca", "Osprey", "Outlaw",
      "Outrider", "Paladin", "Panther", "Pegasus", "Phantom", "Photon", "Pinnacle", "Pioneer",
      "Piranha", "Polaris", "Prism", "Prowler", "Pulsar", "Puma", "Quake", "Radar",
      "Rampart", "Raptor", "Rattler", "Raven", "Razor", "Rebel", "Redline", "Relay",
      "Renegade", "Rhino", "Ricochet", "Rift", "Riptide", "Rocket", "Rogue", "Rook",
      "Rover", "Rumble", "Saber", "Sapphire", "Scimitar", "Scorpion", "Scout", "Sentry",
      "Shadow", "Shockwave", "Shrike", "Sidewinder", "Skyhawk", "Slate", "Sledge", "Solstice",
      "Sonic", "Sparrow", "Spartan", "Specter", "Spike", "Spitfire", "Stallion", "Static",
      "Stealth", "Stinger", "Storm", "Summit", "Sundance", "Surge", "Swift", "Talon",
      "Tank", "Taurus", "Tempest", "Thrasher", "Tiger", "Titan", "Tomcat", "Topaz",
      "Torch", "Tornado", "Tracer", "Trident", "Trooper", "Tundra", "Turbo", "Twister",
      "Typhoon", "Umbra", "Valor", "Vandal", "Vanguard", "Vector", "Velocity", "Venom",
      "Vertigo", "Viper", "Vortex", "Vulcan", "Warthog", "Wasp", "Whiplash", "Whirlwind",
      "Wildcat", "Wolf", "Wolverine", "Wraith", "Yeti", "Zenith", "Zephyr",
    ],
    coinedHeads: [
      "Ash", "Black", "Blue", "Bright", "Cold", "Copper", "Dark", "Dawn", "Dust", "Ember",
      "Fire", "Flint", "Frost", "Ghost", "Gold", "Gray", "Grim", "High", "Ice", "Iron",
      "Jade", "Jet", "Moon", "Night", "North", "Red", "Rust", "Sand", "Shade", "Silver",
      "Sky", "Slate", "Smoke", "Snow", "Star", "Steel", "Stone", "Storm", "Sun", "Swift",
      "Thunder", "Tide", "Void", "West", "Wild", "Wind", "Winter",
    ],
    coinedTails: [
      "bird", "blade", "bolt", "claw", "crest", "drift", "edge", "fall", "fang", "fire",
      "flight", "fox", "gale", "hawk", "horn", "jack", "keel", "lance", "line", "mark",
      "point", "rider", "runner", "shot", "spark", "spear", "spur", "star", "strike", "tail",
      "vane", "watch", "wing", "wolf",
    ],
  },
  whimsical: {
    description: "Gentle everyday and natural words (Teakettle, Lantern, Quillmoor).",
    curated: [
      "Abacus", "Acorn", "Adder", "Almanac", "Amulet", "Anchor", "Anvil", "Apricot",
      "Arbor", "Armada", "Aspen", "Atlas", "Auger", "Aurora", "Avocet", "Azure",
      "Badger", "Bagpipe", "Balsam", "Banjo", "Barley", "Barnacle", "Basalt", "Basin",
      "Bassoon", "Beacon", "Beetle", "Bellows", "Beryl", "Biscuit", "Bittern", "Blanket",
      "Bobbin", "Bonfire", "Bramble", "Bramling", "Breaker", "Brisket", "Bristle", "Brocade",
      "Buckle", "Bugle", "Bullfinch", "Bunting", "Burrow", "Buttress", "Buzzard", "Cactus",
      "Caliper", "Camber", "Candle", "Canopy", "Canteen", "Canyon", "Capstan", "Caravan",
      "Cardinal", "Carillon", "Cascade", "Cashew", "Catkin", "Cellar", "Cello", "Chalice",
      "Chamois", "Chestnut", "Chisel", "Cinder", "Citadel", "Clarion", "Clover", "Cobble",
      "Coconut", "Comet", "Compass", "Coral", "Cormorant", "Corona", "Cosmos", "Cottage",
      "Cougar", "Coyote", "Crane", "Crescent", "Crocus", "Crossbow", "Cupola", "Curlew",
      "Cutlass", "Cygnet", "Cypress", "Dahlia", "Damask", "Damson", "Delta", "Denim",
      "Derrick", "Dewdrop", "Dingo", "Dipper", "Divot", "Dolphin", "Domino", "Dovetail",
      "Dragnet", "Driftwood", "Drumlin", "Dulcimer", "Dynamo", "Easel", "Eclipse", "Eddy",
      "Eider", "Ember", "Emerald", "Epoch", "Ermine", "Estuary", "Falcon", "Farthing",
      "Fathom", "Feather", "Fennel", "Ferret", "Fiddle", "Filbert", "Finch", "Firefly",
      "Fjord", "Flicker", "Flotsam", "Fondue", "Fossil", "Foxglove", "Frigate", "Fulcrum",
      "Furlong", "Galleon", "Gannet", "Gazebo", "Gecko", "Geyser", "Gherkin", "Gimlet",
      "Glacier", "Glimmer", "Gondola", "Gorse", "Granite", "Griffin", "Grotto", "Gusset",
      "Halyard", "Hammock", "Harrier", "Harvest", "Hatchet", "Hawthorn", "Hazel", "Hedgehog",
      "Helix", "Heron", "Hickory", "Hinge", "Hobnail", "Hollow", "Honeybee", "Hopscotch",
      "Hornbeam", "Hyacinth", "Ibis", "Icicle", "Indigo", "Inkwell", "Ironwood", "Islet",
      "Ivory", "Jackdaw", "Jasmine", "Jasper", "Javelin", "Jetty", "Jigsaw", "Jonquil",
      "Juniper", "Kayak", "Keel", "Kelp", "Kestrel", "Kiln", "Kingfisher", "Kiwi",
      "Knapsack", "Koala", "Kumquat", "Ladle", "Lagoon", "Larch", "Lattice", "Laurel",
      "Lavender", "Lentil", "Lichen", "Lilac", "Locket", "Loden", "Longbow", "Lotus",
      "Lugsail", "Lupine", "Lynx", "Mango", "Maple", "Marble", "Marigold", "Marlin",
      "Marmot", "Marsh", "Mason", "Meadow", "Medley", "Meteor", "Midge", "Minnow",
      "Mistral", "Mortar", "Mosaic", "Mulberry", "Narwhal", "Nectar", "Nimbus", "Nomad",
      "Nutmeg", "Oakum", "Oasis", "Oboe", "Ocarina", "Ocelot", "Octave", "Onyx",
      "Opal", "Orbit", "Orchard", "Oriole", "Osprey", "Otter", "Outrigger", "Oxbow",
      "Pagoda", "Paisley", "Palette", "Pantry", "Papaya", "Parsnip", "Pastel", "Pelican",
      "Pendant", "Peony", "Pewter", "Pheasant", "Piccolo", "Pilgrim", "Pinecone", "Pinwheel",
      "Piston", "Plumage", "Pollen", "Pomelo", "Poplar", "Poppy", "Porcupine", "Portico",
      "Prairie", "Prism", "Pumice", "Pumpkin", "Quarry", "Quasar", "Quill", "Quince",
      "Quiver", "Raffia", "Rampart", "Rapier", "Raven", "Rawhide", "Redwood", "Reef",
      "Ripple", "Rivet", "Robin", "Rosehip", "Rowan", "Ruby", "Rudder", "Saffron",
      "Sagebrush", "Samphire", "Sandbar", "Sapling", "Scallop", "Scarab", "Schooner", "Sculpin",
      "Seashell", "Semaphore", "Sequin", "Sextant", "Shilling", "Shingle", "Shuttle", "Sierra",
      "Silo", "Siskin", "Skiff", "Skylark", "Sleet", "Sloop", "Sorrel", "Sparrow",
      "Spinnaker", "Sprocket", "Spruce", "Squall", "Stirrup", "Sundial", "Sycamore", "Tabard",
      "Talon", "Tamarind", "Tambour", "Tangelo", "Tangram", "Tapestry", "Teakettle", "Telescope",
      "Tempest", "Tern", "Thicket", "Thrush", "Toboggan", "Topaz", "Topsail", "Tortoise",
      "Toucan", "Trellis", "Trident", "Trillium", "Trowel", "Truffle", "Tulip", "Tundra",
      "Turmeric", "Tussock", "Upland", "Velvet", "Verbena", "Vernier", "Vetch", "Viola",
      "Vireo", "Vista", "Vortex", "Wagtail", "Walnut", "Wayfarer", "Wharf", "Whippet",
      "Whisker", "Wigeon", "Windmill", "Wombat", "Woodcock", "Wren", "Yardarm", "Yodel",
      "Zenith", "Zephyr", "Zinnia", "Zither",
    ],
    coinedHeads: [
      "Alder", "Ash", "Birch", "Brack", "Brass", "Briar", "Brook", "Cinder", "Clove", "Copper",
      "Crag", "Dusk", "Elm", "Ember", "Fern", "Flax", "Flint", "Frost", "Gale", "Glen",
      "Gorse", "Hazel", "Heath", "Holly", "Hull", "Ivy", "Kelp", "Lark", "Loam", "Marl",
      "Mill", "Moss", "Oak", "Pike", "Quill", "Reed", "Rill", "Rowan", "Rush", "Rye",
      "Sable", "Sage", "Salt", "Sedge", "Slate", "Sorrel", "Tarn", "Teal", "Thorn", "Tide",
      "Wold", "Wren", "Yew",
    ],
    coinedTails: [
      "moor", "wick", "stead", "ford", "mere", "holt", "fell", "combe", "dale", "burn", "gate", "well",
      "ridge", "shaw", "ley", "by", "thorpe", "cote", "garth", "haven", "mouth", "ness", "row", "wood",
      "field", "vale", "brook", "croft", "hurst", "ton", "wyn",
    ],
  },
};
