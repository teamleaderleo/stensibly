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

export const namegenVibes = ["cute", "ops", "lame"] as const;
export type NamegenVibe = typeof namegenVibes[number];
export const defaultNamegenVibe: NamegenVibe = "cute";

export interface NamegenVibePool {
  description: string;
  curated: readonly string[];
  coinedHeads: readonly string[];
  coinedTails: readonly string[];
}

export const namegenVibePools: Readonly<Record<NamegenVibe, NamegenVibePool>> = {
  cute: {
    description: "Cozy, cute everyday words (Teapot, Muffin, Crumpet, Honeypuff).",
    curated: [
      "Acorn", "Apricot", "Avocet", "Bagel", "Banjo", "Berry", "Biscuit", "Blanket",
      "Blossom", "Bluebell", "Bonbon", "Bramble", "Brioche", "Bullfinch", "Bumblebee", "Bunny",
      "Bunting", "Burrow", "Buttercup", "Button", "Canopy", "Caramel", "Cashew", "Catkin",
      "Cello", "Cherry", "Chestnut", "Chipmunk", "Cinnamon", "Clover", "Cocoa", "Coconut",
      "Cottage", "Cozy", "Crocus", "Croissant", "Crouton", "Crumpet", "Cuddle", "Cupcake",
      "Custard", "Cygnet", "Dahlia", "Daisy", "Damson", "Dewdrop", "Dimple", "Dolphin",
      "Domino", "Dumpling", "Easel", "Ermine", "Fawn", "Feather", "Fennel", "Filbert",
      "Finch", "Firefly", "Fondant", "Fondue", "Foxglove", "Gecko", "Gingersnap", "Glimmer",
      "Gumdrop", "Hammock", "Hamster", "Hazelnut", "Hedgehog", "Honeybee", "Hopscotch", "Hyacinth",
      "Ibis", "Icicle", "Inkwell", "Jasmine", "Jellybean", "Jonquil", "Juniper", "Kettle",
      "Kingfisher", "Kitten", "Kiwi", "Koala", "Kumquat", "Ladle", "Ladybug", "Lark",
      "Lavender", "Lilac", "Locket", "Lollipop", "Lotus", "Lupine", "Macaroon", "Mango",
      "Maple", "Marble", "Marigold", "Marmalade", "Marmot", "Meadow", "Meringue", "Minnow",
      "Mochi", "Moonbeam", "Muffin", "Mulberry", "Narwhal", "Nectar", "Noodle", "Nugget",
      "Nutmeg", "Oboe", "Ocarina", "Orchard", "Otter", "Paisley", "Palette", "Pancake",
      "Panda", "Pantry", "Papaya", "Parsnip", "Pastel", "Pawprint", "Peach", "Pebble",
      "Pelican", "Penguin", "Peony", "Petal", "Piccolo", "Pickle", "Pillow", "Pinecone",
      "Pinwheel", "Plum", "Pollen", "Pomelo", "Pompom", "Poppet", "Poppy", "Porcupine",
      "Possum", "Pretzel", "Pudding", "Pumpkin", "Quince", "Radish", "Rainbow", "Raindrop",
      "Robin", "Rosehip", "Saffron", "Scone", "Seashell", "Sequin", "Shortcake", "Skylark",
      "Slipper", "Snowdrop", "Snowflake", "Snuggle", "Sparkle", "Sparrow", "Sprinkle", "Sprout",
      "Squirrel", "Starling", "Strudel", "Sugarplum", "Sunbeam", "Sundial", "Sweater", "Tadpole",
      "Tangelo", "Teacup", "Teakettle", "Teapot", "Thimble", "Thrush", "Tinsel", "Toboggan",
      "Toffee", "Tortoise", "Toucan", "Trifle", "Trillium", "Tulip", "Turnip", "Twinkle",
      "Velvet", "Verbena", "Viola", "Waffle", "Wagtail", "Walnut", "Whisker", "Windmill",
      "Wombat", "Wren", "Yodel", "Zinnia",
    ],
    coinedHeads: [
      "Apple", "Berry", "Bun", "Butter", "Candy", "Cherry", "Clover", "Cocoa", "Cookie", "Daisy",
      "Dew", "Dimple", "Fig", "Fluff", "Fuzzy", "Ginger", "Honey", "Jelly", "Lemon", "Maple",
      "Minty", "Moss", "Muffin", "Nutty", "Pea", "Peach", "Pip", "Plum", "Poppy", "Pudding",
      "Sugar", "Sunny", "Taffy", "Tea", "Toffee", "Tulip", "Waffle", "Wiggle",
    ],
    coinedTails: [
      "bit", "boots", "bug", "dot", "hop", "jam", "loaf", "nook", "sock", "twirl", "wink", "bean",
      "bell", "bloom", "blossom", "bud", "bun", "button", "cake", "crumb", "cup", "drop", "fluff", "kin",
      "moss", "nose", "nut", "paw", "petal", "pie", "pip", "pod", "pop", "puff", "seed", "snap",
      "sprout", "tart", "toes", "whisk",
    ],
  },
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
  lame: {
    description: "Proudly, deliberately lame (Meatloaf, Kerfuffle, Spudnugget).",
    curated: [
      "Bagel", "Bamboozle", "Bathrobe", "Beanbag", "Beetroot", "Biscuit", "Blob", "Boing",
      "Butterbean", "Cabbage", "Cardigan", "Casserole", "Cheddar", "Clothespin", "Coleslaw", "Crayon",
      "Crouton", "Crumpet", "Custard", "Dingus", "Dishrag", "Doily", "Dollop", "Doodad",
      "Doohickey", "Doorknob", "Doorstop", "Dumpling", "Earmuff", "Eraser", "Flapjack", "Freckle",
      "Galosh", "Gherkin", "Gizmo", "Glue", "Gopher", "Gravy", "Gumdrop", "Hairnet",
      "Honk", "Hootenanny", "Hotdish", "Hubcap", "Jellybean", "Kazoo", "Kerfuffle", "Kerplunk",
      "Ketchup", "Kohlrabi", "Lentil", "Lollygag", "Loofah", "Lump", "Mayo", "Meatloaf",
      "Mitten", "Mothball", "Muffin", "Nacho", "Noodle", "Nugget", "Oatmeal", "Oddball",
      "Pancake", "Paperclip", "Parsnip", "Pickle", "Plunger", "Porridge", "Possum", "Potato",
      "Pretzel", "Pudding", "Puddle", "Radish", "Rutabaga", "Sardine", "Scone", "Shenanigan",
      "Slinky", "Slipper", "Smudge", "Sock", "Spatula", "Sponge", "Sprinkle", "Spud",
      "Stapler", "Sweatband", "Tadpole", "Tater", "Thimble", "Thingy", "Tissue", "Toffee",
      "Tofu", "Toot", "Turnip", "Waffle", "Whatsit", "Widget", "Wiggle", "Wobble",
    ],
    coinedHeads: [
      "Bun", "Dork", "Dum", "Fig", "Fudge", "Goo", "Gum", "Lump", "Mush", "Nub",
      "Pud", "Sog", "Spud", "Tot", "Wig", "Wob", "Yam", "Zonk", "Blob", "Bap",
    ],
    coinedTails: [
      "biscuit", "bucket", "doodle", "dumpling", "muffin", "nugget", "noodle", "pickle", "pudding", "sock",
      "sprout", "tater", "waffle", "wiggle", "bean", "bottom", "button", "cake", "kins",
    ],
  },
};
