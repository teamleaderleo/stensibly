#!/usr/bin/env bun
/**
 * Stensibly Overnight Studio Summary (read-only)
 *
 * Runs local repository health checks and takes one read-only snapshot of
 * the coordination ledger for morning review. This is a monitor, not a
 * runner: it does not claim work under lease fences, gathers no approvals,
 * and makes no ledger changes. Its only network effect is
 * GET /api/v1/items, enforced by src/studio-status-read-client.ts.
 * See docs/studio-monitors.md.
 */

import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import {
  createLedgerStatusReader,
  DEFAULT_LEDGER_STATUS_ENDPOINT,
  normalizeLedgerEndpointBase,
} from "../src/studio-status-read-client.js";
import { runOvernightSummaryOnce } from "../src/overnight-studio-summary.js";

/** Declared command surface; pinned by test/studio-monitors-read-only.test.ts. */
export const cliOptionKeys: readonly string[] = ["endpoint", "token", "project", "once", "poll-interval"];

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    endpoint: { type: "string", default: process.env.STENSIBLY_ENDPOINT || DEFAULT_LEDGER_STATUS_ENDPOINT },
    token: { type: "string", default: process.env.STENSIBLY_TOKEN || "" },
    project: { type: "string", default: process.env.STENSIBLY_PROJECT || "scrapbook" },
    once: { type: "boolean", default: false },
    "poll-interval": { type: "string", default: "60" },
  },
  strict: false,
});

function runLocalCheck(command: string, cmdArgs: string[]): boolean {
  try {
    const res = spawnSync(command, cmdArgs, { stdio: "pipe", encoding: "utf8", shell: true });
    return res.status === 0;
  } catch {
    return false;
  }
}

function observeLocalHealth(): { gitClean: boolean; typecheckPass: boolean; testPass: boolean } {
  const gitStatusRes = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  const gitClean = gitStatusRes.status === 0 && !gitStatusRes.stdout.trim();
  console.log(`  [Git] Clean working tree: ${gitClean ? "✅ Clean" : "⚠️ Uncommitted changes detected"}`);

  const typecheckPass = runLocalCheck("bun", ["run", "typecheck"]);
  console.log(`  [TypeScript] Typecheck: ${typecheckPass ? "✅ PASS" : "❌ FAIL"}`);

  const testPass = runLocalCheck("bun", ["test", "test/dashboard-*.test.ts"]);
  console.log(`  [Tests] Core test suite: ${testPass ? "✅ PASS" : "❌ FAIL"}`);

  return { gitClean, typecheckPass, testPass };
}

export async function runCli(): Promise<void> {
  const token = String(args.token || "");
  const project = String(args.project!);
  const pollIntervalMs = Math.max(10, parseInt(String(args["poll-interval"] || "60"), 10)) * 1000;
  const runOnce = args.once || false;

  let endpoint: string;
  try {
    endpoint = normalizeLedgerEndpointBase(String(args.endpoint || DEFAULT_LEDGER_STATUS_ENDPOINT));
  } catch {
    console.error("[Summary] Refused endpoint configuration; nothing displayed, no connection attempted.");
    process.exitCode = 1;
    return;
  }

  console.log(`🌙 [Summary] Stensibly overnight studio summary (read-only) — local checks plus one ledger snapshot`);
  console.log(`🌙 [Summary] Endpoint: ${endpoint} | Project: ${project}`);

  const reader = createLedgerStatusReader({ endpoint, token });

  const cycle = async (): Promise<void> => {
    console.log(`\n🌙 [${new Date().toLocaleTimeString()}] Taking read-only overnight snapshot`);
    const localHealth = observeLocalHealth();
    await runOvernightSummaryOnce({ reader, project, localHealth });
  };

  await cycle();
  if (runOnce) return;

  const interval = setInterval(() => void cycle(), pollIntervalMs);
  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("\n🌙 [Summary] Stopped.");
    process.exit(0);
  });
}

if (import.meta.main) await runCli();
