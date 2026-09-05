#!/usr/bin/env bun
import { compileLocalActionVerifyCommandV1 } from "../src/local-action-verify-admission.js";

if (Bun.argv.slice(2).join(" ") === "--help") {
  console.log("Usage: bun scripts/local-action-verify-admission.ts < admission-request.json > workstation-command.json\nReads {intent, current} where intent is a local_action_intent/v1 input and current carries dispatch-time work/run/authority/node/source/profile facts. Emits one Glaeda workstation command for the existing reservation path; performs no dispatch, provider reads, or ledger writes.");
} else {
  try {
    if (Bun.argv.length !== 2) throw new Error("Unexpected arguments");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of Bun.stdin.stream()) {
      bytes += chunk.byteLength;
      if (bytes > 1_048_576) throw new Error("Input too large");
      chunks.push(chunk);
    }
    const input = JSON.parse(await new Blob(chunks).text());
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid input");
    const { intent, current } = input as Record<string, unknown>;
    console.log(JSON.stringify(compileLocalActionVerifyCommandV1({ intent, current })));
  } catch {
    // Intent facts can carry sensitive source context: never echo parser errors/values.
    console.error("Local verify admission refused: supply one current verify intent with matching dispatch-time facts.");
    process.exitCode = 1;
  }
}
