#!/usr/bin/env bun
/**
 * DEPRECATED read-only alias for scripts/overnight-studio-summary.ts.
 *
 * Renamed in #1632 (monitor path): this file previously claimed to be a
 * "night shift autonomous sweeper" that claimed work under lease fences and
 * gathered approvals. It never did any of that; it ran local checks and read
 * ledger counts. The alias forwards to the summary entry point so existing
 * operator schedules keep working with an explicit deprecation notice. It is
 * equally read-only and contains no network code of its own.
 * See docs/studio-monitors.md.
 */

console.error(
  "[deprecated] scripts/night-shift-daemon.ts is a read-only alias of scripts/overnight-studio-summary.ts (renamed in #1632); update your schedule to call the new name.",
);

const { runCli } = await import("./overnight-studio-summary.js");
await runCli();
