import {
  callsignCollisionKey,
  canonicalCallsignDisplay,
} from "../../src/callsign-derivation.js";

const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export const MAX_HOSTED_CALLSIGN_LEASE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Hosted leases canonicalise through the same derivation the #454 registrar
 * uses, so a name collides identically on both paths.
 */
export function canonicalHostedCallsign(value: string): {
  display: string;
  collisionKey: string;
} {
  // Reject control characters before trimming, as hosted leases always have.
  if (unsafeTextPattern.test(value)) {
    throw new RangeError("Callsign contains unsupported control characters");
  }
  const display = canonicalCallsignDisplay(value);
  return { display, collisionKey: callsignCollisionKey(display) };
}
