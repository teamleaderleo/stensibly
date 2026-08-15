import { describe, expect, test } from "bun:test";
import {
  generateMailThreadHandle,
  parseMailThreadHandle,
} from "../src/mail-thread-contract.ts";

describe("mail thread runtime neutrality", () => {
  test("default cryptographic entropy produces canonical handles", () => {
    for (const threadClass of ["handoff", "review", "decision", "incident"] as const) {
      const handle = generateMailThreadHandle(threadClass);
      expect(parseMailThreadHandle(handle)).toBe(handle);
      expect(handle).toMatch(
        /^STN-(HANDOFF|REVIEW|DECISION|INCIDENT):[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/u,
      );
    }
  });

  test("injected entropy remains exactly deterministic", () => {
    const entropy = Uint8Array.from([0, 1, 2, 3, 4, 5]);
    expect(generateMailThreadHandle("handoff", 6, entropy)).toBe("STN-HANDOFF:234567");
    expect(generateMailThreadHandle("decision", 6, entropy)).toBe("STN-DECISION:234567");
  });

  test("shared mail-thread contract bundles without Node-runtime leakage", async () => {
    const result = await Bun.build({
      entrypoints: ["src/mail-thread-contract.ts"],
      target: "browser",
      format: "esm",
    });
    expect(result.logs.map((entry) => entry.message).join("\n")).toBe("");
    expect(result.success).toBe(true);
  });
});
