#!/usr/bin/env bun
/**
 * Stensibly Studio Brief Monitor (read-only)
 *
 * Polls the coordination ledger's item list and prints a studio brief.
 * This is a monitor, not a runner: it holds no lease, claims no work,
 * emits no approvals, and advances nothing. Its only network effect is
 * GET /api/v1/items, enforced by src/studio-status-read-client.ts.
 * See docs/studio-monitors.md.
 */

import { parseArgs } from "node:util";
import {
  createLedgerStatusReader,
  DEFAULT_LEDGER_STATUS_ENDPOINT,
  normalizeLedgerEndpointBase,
} from "../src/studio-status-read-client.js";
import { runStudioBriefOnce } from "../src/studio-brief-monitor.js";

/** Declared command surface; pinned by test/studio-monitors-read-only.test.ts. */
export const cliOptionKeys: readonly string[] = ["endpoint", "token", "project", "once", "poll-interval"];

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    endpoint: { type: "string", default: process.env.STENSIBLY_ENDPOINT || DEFAULT_LEDGER_STATUS_ENDPOINT },
    token: { type: "string", default: process.env.STENSIBLY_TOKEN || "" },
    project: { type: "string", default: process.env.STENSIBLY_PROJECT || "scrapbook" },
    once: { type: "boolean", default: false },
    "poll-interval": { type: "string", default: "30" },
  },
  strict: false,
});

export async function runCli(): Promise<void> {
  const token = String(args.token || "");
  const project = String(args.project!);
  const pollIntervalMs = Math.max(5, parseInt(String(args["poll-interval"] || "30"), 10)) * 1000;
  const runOnce = args.once || false;

  let endpoint: string;
  try {
    endpoint = normalizeLedgerEndpointBase(String(args.endpoint || DEFAULT_LEDGER_STATUS_ENDPOINT));
  } catch {
    console.error("[Monitor] Refused endpoint configuration; nothing displayed, no connection attempted.");
    process.exitCode = 1;
    return;
  }

  console.log(`[Monitor] Stensibly studio brief monitor (read-only) — observes the ledger; claims nothing`);
  console.log(`[Monitor] Endpoint: ${endpoint} | Project: ${project}`);

  const reader = createLedgerStatusReader({ endpoint, token });

  const cycle = async (): Promise<void> => {
    const timestamp = new Date().toLocaleTimeString();
    try {
      await runStudioBriefOnce({ reader, project });
    } catch (error) {
      console.error(`[${timestamp}] Poll error:`, error instanceof Error ? error.message : error);
    }
  };

  await cycle();
  if (runOnce) return;

  const interval = setInterval(() => void cycle(), pollIntervalMs);
  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("\n[Monitor] Stopped.");
    process.exit(0);
  });
}

if (import.meta.main) await runCli();
