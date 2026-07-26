import { describe, expect, test } from "bun:test";
import {
  custodianUsage,
  parseCustodianArgs,
} from "../src/custodian.ts";

describe("custodian CLI", () => {
  test("defaults to read-only observe mode", () => {
    expect(parseCustodianArgs([])).toEqual({
      staleDays: 7,
      expiringWithinMinutes: 5,
      mode: "observe",
      maxActions: 100,
      failOnFindings: false,
      showHelp: false,
    });
  });

  test("parses bounded dry-run and project scope", () => {
    expect(parseCustodianArgs([
      "--dry-run",
      "--project",
      "scrapbook",
      "--max-actions",
      "20",
      "--stale-days",
      "14",
      "--expiring-within",
      "10",
      "--fail-on-findings",
    ])).toEqual({
      project: "scrapbook",
      staleDays: 14,
      expiringWithinMinutes: 10,
      mode: "dry-run",
      maxActions: 20,
      failOnFindings: true,
      showHelp: false,
    });
  });

  test("supports explicit apply mode", () => {
    expect(parseCustodianArgs(["--mode", "apply", "--max-actions", "0"]))
      .toMatchObject({ mode: "apply", maxActions: 0 });
  });

  test("rejects ambiguous or invalid modes", () => {
    expect(() => parseCustodianArgs(["--dry-run", "--apply"]))
      .toThrow("Choose only one custodian mode");
    expect(() => parseCustodianArgs(["--mode", "apply", "--dry-run"]))
      .toThrow("Choose only one custodian mode");
    expect(() => parseCustodianArgs(["--mode", "automatic"]))
      .toThrow("--mode must be observe, dry-run, or apply");
  });

  test("validates action limits and project slugs", () => {
    expect(() => parseCustodianArgs(["--max-actions", "1.5"]))
      .toThrow("--max-actions requires a whole number");
    expect(() => parseCustodianArgs(["--max-actions", "10001"]))
      .toThrow("--max-actions must be between 0 and 10000");
    expect(() => parseCustodianArgs(["--project", "Other Project"]))
      .toThrow("--project must be a lowercase project slug");
  });

  test("documents the conservative execution boundary", () => {
    const usage = custodianUsage();
    expect(usage).toContain("observe (default)           Read-only");
    expect(usage).toContain("dry-run                     Read-only exact bounded action plan");
    expect(usage).toContain("apply                       Apply bounded invariant reconciliation only");
    expect(usage).toContain("semantic transitions such as block, unblock, complete, handoff, and reassignment: disabled");
  });
});
