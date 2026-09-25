import { createHash } from "node:crypto";
import { callsignCollisionKey, canonicalCallsignDisplay } from "./callsign-derivation.js";

const callsignSigilPool = [
  "🔹",
  "🔸",
  "🌀",
  "✨",
  "🌙",
  "☀️",
  "🌿",
  "🍂",
  "🧭",
  "🪁",
  "🕯️",
  "🧵",
  "🧩",
  "🎲",
  "♟️",
  "📚",
  "🗝️",
  "🔔",
  "🪶",
  "🪨",
  "🪵",
  "🫧",
  "🌊",
  "🌱",
  "🌾",
  "🍄",
  "🐚",
  "🦋",
  "🐝",
  "🐾",
  "🦉",
  "🐦",
  "🛠️",
  "⚙️",
  "🔭",
  "🧪",
  "📎",
  "✒️",
  "🎐",
  "🎒",
  "🎯",
  "🪄",
  "💾",
  "🖇️",
  "🧶",
  "🪙",
  "🔆",
  "💠",
] as const;

const callsignSigilOverrides: Readonly<Record<string, string>> = {
  rook: "🪶",
  lantern: "🏮",
  teacup: "🫖",
  compass: "🧭",
  anvil: "⚒️",
  merlin: "🪄",
  pixel: "💠",
  debugduck: "🦆",
  rubberduck: "🦆",
  stacktrace: "🧵",
  breadcrumb: "🍞",
  hotfix: "🩹",
};

export interface CallsignSigilResult {
  version: 1;
  callsign: string;
  collisionKey: string;
  sigil: string;
  source: "override" | "derived";
  reservesSigil: false;
  grantsIdentityContinuity: false;
  grantsAuthority: false;
}

/**
 * Returns stable visual decoration for a callsign.
 *
 * Sigils are intentionally derived metadata. They are allowed to collide and
 * never receive a lease, generation, identity, responsibility, or authority.
 */
export function callsignSigil(callsign: string): CallsignSigilResult {
  const display = canonicalCallsignDisplay(callsign);
  const collisionKey = callsignCollisionKey(display);
  const overridden = callsignSigilOverrides[collisionKey];
  const sigil = overridden ?? derivedSigil(collisionKey);

  return {
    version: 1,
    callsign: display,
    collisionKey,
    sigil,
    source: overridden === undefined ? "derived" : "override",
    reservesSigil: false,
    grantsIdentityContinuity: false,
    grantsAuthority: false,
  };
}

function derivedSigil(collisionKey: string): string {
  const digest = createHash("sha256")
    .update("stensibly-callsign-sigil/v1")
    .update("\0")
    .update(collisionKey)
    .digest();
  const index = digest.readUInt32BE(0) % callsignSigilPool.length;
  const sigil = callsignSigilPool[index];
  if (!sigil) throw new Error("Callsign sigil pool unexpectedly returned no entry");
  return sigil;
}
