#!/usr/bin/env bun
/**
 * DEPRECATED read-only alias for scripts/studio-brief-monitor.ts.
 *
 * Renamed in #1632 (monitor path): this file previously claimed to be an
 * "autonomous worker daemon". It never claimed, dispatched, or advanced
 * work; it was always a status monitor. The alias forwards to the monitor
 * entry point so existing operator schedules keep working with an explicit
 * deprecation notice. It is equally read-only and contains no network code
 * of its own. See docs/studio-monitors.md.
 */

console.error(
  "[deprecated] scripts/autonomous-worker-daemon.ts is a read-only alias of scripts/studio-brief-monitor.ts (renamed in #1632); update your schedule to call the new name.",
);

const { runCli } = await import("./studio-brief-monitor.js");
await runCli();
