/**
 * The single source of callsign canonicalisation.
 *
 * The #454 registrar, hosted Convex leases, worker enrolment, and namegen all
 * compare callsigns through these functions, so any caller computes exactly the
 * collision key the registrar stamps on a receipt. This module stays free of
 * imports so the Convex runtime can bundle it; the sigil, which needs a hash,
 * lives in `callsign-sigils.ts` and is keyed by the collision key from here.
 */

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const callsignDisplayPattern = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

export const maximumCallsignLength = 80;

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

/**
 * Returns the display form a receipt records: NFKC, trimmed, inner space runs
 * collapsed. Throws when the callsign has no valid collision key.
 */
export function canonicalCallsignDisplay(value: string): string {
  if (typeof value !== "string") throw new RangeError("Callsign must be text");
  const display = value.normalize("NFKC").trim().replace(/ {2,}/g, " ");
  callsignCollisionKey(display);
  return display;
}
