const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const callsignDisplayPattern = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
const MAX_CALLSIGN_LENGTH = 80;

export const MAX_HOSTED_CALLSIGN_LEASE_SECONDS = 7 * 24 * 60 * 60;

export function canonicalHostedCallsign(value: string): {
  display: string;
  collisionKey: string;
} {
  if (unsafeTextPattern.test(value)) {
    throw new Error("Callsign contains unsupported control characters");
  }
  const display = value.normalize("NFKC").trim().replace(/ {2,}/g, " ");
  if (display.length === 0) throw new Error("Callsign must not be empty");
  if ([...display].length > MAX_CALLSIGN_LENGTH) {
    throw new Error(`Callsign must be at most ${MAX_CALLSIGN_LENGTH} characters`);
  }
  if (!callsignDisplayPattern.test(display)) {
    throw new Error("Callsign contains unsupported characters");
  }
  const collisionKey = display.toLowerCase().replace(/[ _-]+/g, "");
  if (!collisionKey) throw new Error("Callsign must contain a letter or number");
  return { display, collisionKey };
}
