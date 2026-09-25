import {
  callsignCollisionKey,
  canonicalCallsignDisplay,
} from "../../src/callsign-derivation.js";

export const MAX_HOSTED_CALLSIGN_LEASE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Hosted leases canonicalise through the same derivation the #454 registrar
 * uses, so a name collides identically on both paths.
 */
export function canonicalHostedCallsign(value: string): {
  display: string;
  collisionKey: string;
} {
  const display = canonicalCallsignDisplay(value);
  return { display, collisionKey: callsignCollisionKey(display) };
}
