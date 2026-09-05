#!/usr/bin/env bun
import { projectHelperRoutingEvidenceV1 } from "../src/helper-routing-evidence.js";

if (Bun.argv.slice(2).join(" ") === "--help") {
  console.log("Usage: bun scripts/helper-routing-evidence.ts < adapter-results.json > research-evidence.json\nReads one Glaeda workstation adapter result or an array (maximum 128, 1 MiB). Emits Cultist helper-routing evidence; does not fetch, dispatch or infer work acceptance.");
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
    console.log(JSON.stringify(projectHelperRoutingEvidenceV1(input)));
  } catch {
    // Input can contain private receipt fields: never echo parser errors/values.
    console.error("Helper routing projection refused: supply bounded matching Glaeda adapter results.");
    process.exitCode = 1;
  }
}
