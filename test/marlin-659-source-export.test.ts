import { describe, test } from "bun:test";
import { Buffer } from "node:buffer";

const sourcePath = "src/runner-adapters/openai-agents.ts";
const mainTestPath = "test/openai-agents-runner-adapter.test.ts";
const boundaryPath = "test/openai-agents-runner-adapter-boundaries.test.ts";
const files = [sourcePath, mainTestPath, boundaryPath] as const;

function replaceExact(
  text: string,
  before: string,
  after: string,
  label: string,
): string {
  const first = text.indexOf(before);
  if (first < 0 || text.indexOf(before, first + before.length) >= 0) {
    throw new Error(`marlin_659_anchor_invalid:${label}`);
  }
  return text.slice(0, first) + after + text.slice(first + before.length);
}

describe("Marlin 659 exact repaired source export", () => {
  test("exports accepted profile-bound repair bytes into CI diagnostics", async () => {
    let source = await Bun.file(new URL(`../${sourcePath}`, import.meta.url)).text();
    source = replaceExact(
      source,
      "      || (input.replayed === false && record.createdAt !== append.proposedCreatedAt)\n",
      `      || (\n        input.replayed\n          ? record.createdAt > append.proposedCreatedAt\n          : record.createdAt !== append.proposedCreatedAt\n      )\n`,
      "checkpoint-chronology",
    );
    source = replaceExact(
      source,
      `    assertControlAuthorityActive(input, clock.baseMilliseconds);\n    const checkpoint = this.#latestCheckpoints.get(controlKey(input));\n    if (!checkpoint) {\n      throw new RangeError(\n        "OpenAI Agents latest checkpoint reference is unknown to this adapter instance",\n      );\n    }\n    this.#assertControlBinding(input);\n    return checkpoint;\n`,
      `    assertControlAuthorityActive(input, clock.baseMilliseconds);\n    this.#assertControlBinding(input);\n    const checkpoint = this.#latestCheckpoints.get(controlKey(input));\n    if (!checkpoint) {\n      throw new RangeError(\n        "OpenAI Agents latest checkpoint reference is unknown to this adapter instance",\n      );\n    }\n    return checkpoint;\n`,
      "authority-before-cache",
    );
    source = replaceExact(
      source,
      `function controlKey(input: {\n  runId: string;\n  runGeneration: number;\n  leaseGeneration: number;\n}): string {\n  return \`\${input.runId}:\${input.runGeneration}:\${input.leaseGeneration}\`;\n}\n`,
      `function controlKey(input: {\n  profileId: string;\n  runId: string;\n  runGeneration: number;\n  leaseGeneration: number;\n}): string {\n  return \`\${input.profileId}:\${input.runId}:\${input.runGeneration}:\${input.leaseGeneration}\`;\n}\n`,
      "profile-bound-control-key",
    );
    await Bun.write(new URL(`../${sourcePath}`, import.meta.url), source);

    let boundary = await Bun.file(new URL(`../${boundaryPath}`, import.meta.url)).text();
    boundary = replaceExact(
      boundary,
      `    expect(candidateFactory.prepareCalls).toBe(1);\n    expect(store.checkpointWrites).toBe(2);\n  });\n`,
      `    expect(candidateFactory.prepareCalls).toBe(1);\n    expect(store.checkpointWrites).toBe(2);\n\n    await expect(\n      (candidate.adapter.requestCheckpoint as any)({\n        ...checkpointCommand(),\n        authority: {\n          ...controlAuthority(),\n          holderId: "competing-boundary-actor",\n        },\n      }),\n    ).rejects.toThrow("authority holder is stale");\n  });\n`,
      "cached-competing-holder",
    );
    boundary = replaceExact(
      boundary,
      `      serializedState: "{}",\n      stateDigest: \`sha256:\${"0".repeat(64)}\`,\n      runtimeManifest: {},\n`,
      `      serializedState: "{}",\n      runtimeManifest: {},\n`,
      "hostile-digest-literal",
    );
    boundary = replaceExact(
      boundary,
      `    Object.defineProperty(record, "stateDigest", {\n      enumerable: true,\n      get() {\n`,
      `    Object.defineProperty(record, "stateDigest", {\n      enumerable: true,\n      configurable: true,\n      get() {\n`,
      "hostile-digest-accessor",
    );
    await Bun.write(new URL(`../${boundaryPath}`, import.meta.url), boundary);

    let mainTest = await Bun.file(new URL(`../${mainTestPath}`, import.meta.url)).text();
    mainTest = replaceExact(
      mainTest,
      `function resumeCommand(\n  checkpointRef: RunnerExternalReferenceV1,\n  leaseGeneration = 1,\n): RunnerResumeCommandV1 {\n`,
      `function resumeCommand(\n  checkpointRef: RunnerExternalReferenceV1,\n  leaseGeneration = 1,\n  holderId = "runner-actor",\n): RunnerResumeCommandV1 {\n`,
      "resume-holder-argument",
    );
    mainTest = replaceExact(
      mainTest,
      `      "2026-07-31T00:10:00.000Z",\n      leaseGeneration,\n    ),\n`,
      `      "2026-07-31T00:10:00.000Z",\n      leaseGeneration,\n      holderId,\n    ),\n`,
      "resume-holder-forwarding",
    );
    mainTest = replaceExact(
      mainTest,
      `function commandBase(\n  commandId: string,\n  issuedAt: string,\n  leaseGeneration: number,\n) {\n`,
      `function commandBase(\n  commandId: string,\n  issuedAt: string,\n  leaseGeneration: number,\n  holderId = "runner-actor",\n) {\n`,
      "command-holder-argument",
    );
    mainTest = replaceExact(
      mainTest,
      `      holderId: leaseGeneration === 1 ? "runner-actor" : "competing-actor",\n`,
      `      holderId,\n`,
      "command-holder-value",
    );
    mainTest = replaceExact(
      mainTest,
      `      candidate.adapter.resume(resumeCommand(checkpoint, 2)),\n`,
      `      candidate.adapter.resume(resumeCommand(checkpoint, 2, "runner-actor")),\n`,
      "competing-lease-holder",
    );
    mainTest = replaceExact(
      mainTest,
      `    profiles: [{ id: profileId, version: profileVersion }],\n`,
      `    profiles: [\n      { id: profileId, version: profileVersion },\n      { id: "alternate-agent", version: profileVersion },\n    ],\n`,
      "alternate-profile-fixture",
    );
    const suiteMarker = "\n});\n\nfunction lineageKey";
    const profileTest = `\n\n  test("binds checkpoint and cancellation controls to the admitted profile", async () => {\n    const store = new MemoryExternalStore();\n    const candidate = createAdapter(store);\n    const checkpoint = await prepareCheckpoint(candidate.adapter);\n    const baseControl = {\n      version: RUNNER_ADAPTER_V1,\n      adapterId,\n      adapterVersion,\n      runId,\n      runGeneration: 1,\n      leaseGeneration: 1,\n      authority: {\n        resource: \`run:\${runId}\`,\n        holderId: "runner-actor",\n        generation: 1,\n        expiresAt: "2026-07-31T01:00:00.000Z",\n      },\n      requestedAt: "2026-07-31T00:20:00.000Z",\n    };\n\n    expect(await (candidate.adapter.requestCheckpoint as any)({\n      ...baseControl,\n      commandId: "command-openai-checkpoint-regular",\n      profileId,\n    })).toEqual(checkpoint);\n\n    await expect((candidate.adapter.requestCheckpoint as any)({\n      ...baseControl,\n      commandId: "command-openai-checkpoint-alternate",\n      profileId: "alternate-agent",\n    })).rejects.toThrow("authority holder is unknown");\n\n    await expect((candidate.adapter.requestCancellation as any)({\n      ...baseControl,\n      commandId: "command-openai-cancel-alternate",\n      profileId: "alternate-agent",\n      reason: "profile isolation control",\n    })).rejects.toThrow("authority holder is unknown");\n  });\n`;
    mainTest = replaceExact(
      mainTest,
      suiteMarker,
      profileTest + suiteMarker,
      "profile-control-test",
    );
    await Bun.write(new URL(`../${mainTestPath}`, import.meta.url), mainTest);

    for (const path of files) {
      const bytes = await Bun.file(new URL(`../${path}`, import.meta.url)).arrayBuffer();
      console.log(`MARLIN_FILE_START ${path}`);
      console.log(Buffer.from(bytes).toString("base64"));
      console.log(`MARLIN_FILE_END ${path}`);
    }
    throw new Error("marlin_659_repaired_source_export_complete");
  });
});
