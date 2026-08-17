#!/usr/bin/env bun
/**
 * Stensibly Autonomous Worker Daemon
 *
 * Runs a continuous monitoring and task intake loop against the Stensibly
 * coordination ledger. Used by Antigravity /goal and /schedule tasks to
 * continuously pick up, verify, and advance studio work items without manual prompts.
 */

import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    endpoint: { type: 'string', default: process.env.STENSIBLY_ENDPOINT || 'https://api.stensibly.com' },
    token: { type: 'string', default: process.env.STENSIBLY_TOKEN || '' },
    project: { type: 'string', default: process.env.STENSIBLY_PROJECT || 'scrapbook' },
    callsign: { type: 'string', default: process.env.STENSIBLY_CALLSIGN || 'Lark' },
    once: { type: 'boolean', default: false },
    'poll-interval': { type: 'string', default: '30' },
  },
  strict: false,
});

const endpoint = args.endpoint!.replace(/\/+$/, '');
const token = args.token || '';
const project = args.project!;
const callsign = args.callsign!;
const pollIntervalMs = Math.max(5, parseInt(args['poll-interval'] || '30', 10)) * 1000;
const runOnce = args.once || false;

console.log(`[Daemon] Starting Stensibly autonomous goal runner`);
console.log(`[Daemon] Endpoint: ${endpoint} | Project: ${project} | Callsign: ${callsign}`);

interface StensiblyItem {
  id: string;
  project: string;
  kind: string;
  title: string;
  status: 'ready' | 'active' | 'blocked' | 'done' | 'archived';
  priority: number;
  claimedBy?: string;
  nextAction?: string;
  updatedAt: string;
}

interface ProjectBrief {
  project: string;
  activeCount: number;
  blockedCount: number;
  readyCount: number;
  topReadyItem?: StensiblyItem;
  topBlockedItem?: StensiblyItem;
}

async function fetchProjectItems(): Promise<StensiblyItem[]> {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;

  const url = `${endpoint}/api/v1/items?project=${encodeURIComponent(project)}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch items from ${url} (HTTP ${response.status})`);
  }
  const data = await response.json();
  return Array.isArray(data?.items) ? data.items : [];
}

async function evaluateStudioState(): Promise<ProjectBrief> {
  const items = await fetchProjectItems();
  const active = items.filter((i) => i.status === 'active');
  const blocked = items.filter((i) => i.status === 'blocked');
  const ready = items.filter((i) => i.status === 'ready').sort((a, b) => b.priority - a.priority);

  return {
    project,
    activeCount: active.length,
    blockedCount: blocked.length,
    readyCount: ready.length,
    topReadyItem: ready[0],
    topBlockedItem: blocked[0],
  };
}

async function cycle() {
  const timestamp = new Date().toLocaleTimeString();
  try {
    const brief = await evaluateStudioState();
    console.log(`\n[${timestamp}] --- Studio Brief for ${project} ---`);
    console.log(`  ⚡ In Motion : ${brief.activeCount} items`);
    console.log(`  ⚠️ Blocked   : ${brief.blockedCount} items ${brief.topBlockedItem ? `(Top: "${brief.topBlockedItem.title}")` : ''}`);
    console.log(`  🎯 Ready Next: ${brief.readyCount} items ${brief.topReadyItem ? `(Next: "${brief.topReadyItem.title}" [p${brief.topReadyItem.priority}])` : ''}`);

    if (brief.topBlockedItem) {
      console.log(`[Action] Attention needed on item: ${brief.topBlockedItem.id} ("${brief.topBlockedItem.title}")`);
      console.log(`         Next action: ${brief.topBlockedItem.nextAction || 'Unspecified'}`);
    } else if (brief.topReadyItem) {
      console.log(`[Action] Ready to claim next task: ${brief.topReadyItem.id} ("${brief.topReadyItem.title}")`);
      console.log(`         Next move: ${brief.topReadyItem.nextAction || 'Begin implementation'}`);
    } else {
      console.log(`[Status] All clear · no unhandled tasks in queue.`);
    }
  } catch (error) {
    console.error(`[${timestamp}] Poll error:`, error instanceof Error ? error.message : error);
  }
}

async function main() {
  await cycle();
  if (runOnce) return;

  const interval = setInterval(cycle, pollIntervalMs);
  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log('\n[Daemon] Stopped.');
    process.exit(0);
  });
}

main();
