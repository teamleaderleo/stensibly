import {
  assertFetchReceiverProfile,
  runFetchReceiverMatrix,
} from "./fetch-receiver-matrix.mjs";

const profile = process.argv[2] ?? "server-runtime";
const runtime = typeof Bun === "undefined"
  ? `Node ${process.version}`
  : `Bun ${Bun.version}`;

const results = await runFetchReceiverMatrix();
assertFetchReceiverProfile(results, profile);

console.log(JSON.stringify({ runtime, profile, results }, null, 2));
