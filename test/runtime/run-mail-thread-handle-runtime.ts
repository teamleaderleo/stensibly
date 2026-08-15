import {
  generateMailThreadHandle,
  parseMailThreadHandle,
} from "../../src/mail-thread-contract.ts";

const alphabetPattern = /^STN-HANDOFF:[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/u;
const deterministic = generateMailThreadHandle(
  "handoff",
  6,
  Uint8Array.from([0, 1, 2, 3, 4, 5]),
);
if (deterministic !== "STN-HANDOFF:234567") {
  throw new Error(`Deterministic mail handle changed: ${deterministic}`);
}

const generated = generateMailThreadHandle("handoff");
if (!alphabetPattern.test(generated) || parseMailThreadHandle(generated) !== generated) {
  throw new Error(`Runtime generated a non-canonical mail handle: ${generated}`);
}

console.log(JSON.stringify({ deterministic, generatedClass: "handoff", tokenLength: 6 }));
