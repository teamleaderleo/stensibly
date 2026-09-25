import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalHostedCallsign } from "../convex/lib/callsign.ts";
import { callsignCollisionKey, canonicalCallsignDisplay } from "../src/callsign-derivation.ts";
import {
  assessCallsign,
  callsignPhoneticKey,
  callsignQualityIssues,
  coinedCallsigns,
  conflictKind,
  proposeCallsigns,
} from "../src/callsign-namegen.ts";
import {
  parseNamegenArgs,
  registrySnapshotFromComments,
  resolveVibeChoice,
  runNamegen,
  type IssueComment,
} from "../src/callsign-namegen-cli.ts";
import { namegenVibePools, namegenVibes } from "../src/callsign-namegen-pool.ts";
import { callsignSigil } from "../src/callsign-sigils.ts";
import {
  decideGitHubCallsignCommand,
  formatGitHubCallsignReceipt,
  parseGitHubCallsignCommand,
  type GitHubCallsignReceiptDraft,
} from "../src/github-callsign-registry.ts";

const vectors = (JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/callsign-derivation-vectors.json"), "utf8"),
) as {
  vectors: Array<{ input: string; callsign: string; collisionKey: string; sigil: string; source: string }>;
}).vectors;

const registryUrl = "https://github.com/teamleaderleo/stensibly/issues/454";

describe("callsign derivation contract", () => {
  test("reproduces every sigil and collision key pinned before the move", () => {
    expect(vectors.length).toBeGreaterThan(300);
    for (const vector of vectors) {
      const derived = callsignSigil(vector.input);
      expect({ input: vector.input, ...derived }).toMatchObject(vector);
      expect(callsignCollisionKey(vector.input)).toBe(vector.collisionKey);
      expect(canonicalCallsignDisplay(vector.input)).toBe(vector.callsign);
    }
  });

  test("hosted Convex leases canonicalise exactly like the registrar", () => {
    for (const vector of vectors) {
      expect(canonicalHostedCallsign(vector.input)).toEqual({
        display: vector.callsign,
        collisionKey: vector.collisionKey,
      });
    }
  });

  test("the registrar stamps the sigil namegen derives", () => {
    for (const [callsign, sigil] of [["Teakettle", "💾"], ["Quillmoor", "🌊"]] as const) {
      const decision = decideGitHubCallsignCommand({
        command: parseGitHubCallsignCommand(
          `/callsign reserve ${callsign}\nrun: run_x_01\nsession: s-01\nttl: 24h`,
        ),
        requestComment: `${registryUrl}#issuecomment-1`,
        receipts: [],
        evaluatedAt: "2026-09-25T00:00:00Z",
      });
      expect(decision.receipt?.sigil).toBe(sigil);
      expect(proposeCallsigns({ seed: "x", taken: [] }).proposals[0]?.sigil).toBe(
        callsignSigil(proposeCallsigns({ seed: "x", taken: [] }).proposals[0]!.callsign).sigil,
      );
    }
  });
});

describe("namegen confusability", () => {
  test.each([
    ["slateharrow", "slateharrier", "prefix"],
    ["quillmoor", "kwilmoor", "phonetic"],
    ["wren", "ren", "phonetic"],
    ["lantern", "lanturn", "edit"],
    ["merlin", "marlin", "edit"],
    ["modem", "rnodem", "visual"],
    ["rook", "rook", "exact"],
  ] as const)("%s and %s are a %s conflict", (left, right, kind) => {
    expect(conflictKind(left, right)).toBe(kind);
    expect(conflictKind(right, left)).toBe(kind);
  });

  test.each([
    ["heron", "lemur"],
    ["pendant", "orbit"],
    ["teakettle", "quillmoor"],
    ["kestrel", "compass"],
  ] as const)("%s and %s are distinct", (left, right) => {
    expect(conflictKind(left, right)).toBeNull();
  });

  test("phonetic keys fold spelling variants", () => {
    expect(callsignPhoneticKey("quillmoor")).toBe(callsignPhoneticKey("kwilmoor"));
    expect(callsignPhoneticKey("philter")).toBe(callsignPhoneticKey("filter"));
    expect(callsignPhoneticKey("knack")).toBe(callsignPhoneticKey("nak"));
  });
});

describe.each([...namegenVibes])("namegen %s pool", (vibe) => {
  const curated = namegenVibePools[vibe].curated;

  test("every curated name is readable, role-free, and distinct from every other", () => {
    expect(curated.length).toBeGreaterThanOrEqual(200);
    const keys = curated.map(callsignCollisionKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const name of curated) {
      expect({ name, issues: callsignQualityIssues(name) }).toEqual({ name, issues: [] });
      expect(name).toMatch(/^[A-Z][a-z]{3,9}$/);
    }
    const confusable: string[] = [];
    for (let left = 0; left < keys.length; left += 1) {
      for (let right = left + 1; right < keys.length; right += 1) {
        const kind = conflictKind(keys[left]!, keys[right]!);
        if (kind !== null) confusable.push(`${keys[left]}~${keys[right]}:${kind}`);
      }
    }
    expect(confusable).toEqual([]);
  });

  test("coined names stay within bounds and pass the same readability rules", () => {
    const coined = coinedCallsigns(vibe);
    expect(coined.length).toBeGreaterThan(500);
    for (const name of coined) {
      expect(callsignQualityIssues(name)).toEqual([]);
      expect(name.length).toBeGreaterThanOrEqual(4);
      expect(name.length).toBeLessThanOrEqual(10);
    }
  });
});

describe("namegen proposals", () => {
  const taken = ["SlateHarrow", "Quillmoor", "Teakettle", "Rook", "Lantern", "CedarWren"];

  test("replays from run and session regardless of taken-list order", () => {
    const first = proposeCallsigns({ run: "run_a", session: "s-1", taken, count: 5 });
    const second = proposeCallsigns({ run: "run_a", session: "s-1", taken: [...taken].reverse(), count: 5 });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      version: 1,
      seedSource: "run-session",
      reservesCallsign: false,
      grantsIdentityContinuity: false,
      grantsAuthority: false,
    });
    const other = proposeCallsigns({ run: "run_b", session: "s-1", taken, count: 5 });
    expect(other.proposals.map((entry) => entry.callsign)).not.toEqual(
      first.proposals.map((entry) => entry.callsign),
    );
  });

  test("never proposes a name confusable with a taken name or another proposal", () => {
    const result = proposeCallsigns({ seed: "clearance", taken, count: 20 });
    const keys = result.proposals.map((entry) => entry.collisionKey);
    for (const [index, key] of keys.entries()) {
      for (const name of taken) expect(conflictKind(key, callsignCollisionKey(name))).toBeNull();
      for (const other of keys.slice(index + 1)) expect(conflictKind(key, other)).toBeNull();
    }
  });

  test("prefers sigils no active lease is showing", () => {
    const activeSigils = ["🔹", "🔸", "🌀", "✨", "🌙", "☀️", "🌿", "🍂", "🧭", "🪁"];
    const result = proposeCallsigns({ seed: "sigils", activeSigils, count: 10 });
    expect(result.proposals.every((entry) => !activeSigils.includes(entry.sigil))).toBe(true);
    expect(new Set(result.proposals.map((entry) => entry.sigil)).size).toBe(10);
    expect(result.proposals.every((entry) => entry.sigilSharedWithActiveLease === false)).toBe(true);
  });

  test("older history blocks only same-word names, so the pool is not consumed by rhymes", () => {
    const history = ["Kettle", "Quillmoor"];
    const assessment = assessCallsign("Beetle", [], history);
    expect(assessment.conflicts).toEqual([]);
    expect(assessCallsign("Kwilmoor", [], history).conflicts).toEqual([{ kind: "phonetic", callsign: "Quillmoor" }]);
    expect(assessCallsign("Beetle", history).conflicts).toEqual([{ kind: "edit", callsign: "Kettle" }]);
  });

  test("keeps proposing after a thousand past names", () => {
    const history: string[] = [];
    const started = performance.now();
    for (let round = 0; round < 1_000; round += 1) {
      const [proposal] = proposeCallsigns({ seed: `capacity-${round}`, taken: history.slice(-40), history }).proposals;
      history.push(proposal!.callsign);
    }
    expect(new Set(history.map(callsignCollisionKey)).size).toBe(1_000);
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 60_000);

  test.each([...namegenVibes])("%s moves to coined names once its curated pool is taken", (vibe) => {
    const curated = namegenVibePools[vibe].curated;
    const result = proposeCallsigns({ seed: "overflow", vibe, history: [...curated], count: 3 });
    expect(result.proposals.every((entry) => entry.tier === "coined")).toBe(true);
    expect(result.vibe).toBe(vibe);
  });
});

describe("namegen vibes", () => {
  test("a vibe changes the words, never the sigil or collision key", () => {
    const ops = proposeCallsigns({ seed: "vibe", vibe: "ops", count: 5 });
    const whimsical = proposeCallsigns({ seed: "vibe", vibe: "whimsical", count: 5 });
    expect(ops.proposals.map((entry) => entry.callsign)).not.toEqual(
      whimsical.proposals.map((entry) => entry.callsign),
    );
    for (const entry of [...ops.proposals, ...whimsical.proposals]) {
      expect(entry.sigil).toBe(callsignSigil(entry.callsign).sigil);
      expect(entry.collisionKey).toBe(callsignCollisionKey(entry.callsign));
    }
    expect(proposeCallsigns({ seed: "vibe" }).vibe).toBe("ops");
    expect(() => proposeCallsigns({ vibe: "grim" as never })).toThrow("choose one of: ops, whimsical");
  });

  test("resolves flag, then env, then the nearest repo config, then the user config", () => {
    const files: Record<string, unknown> = {
      "/work/team/.callsign.json": { vibe: "whimsical" },
      "/home/me/.config/callsign/config.json": { vibe: "ops" },
    };
    const read = (path: string) => files[path];
    const env = { HOME: "/home/me" };
    expect(resolveVibeChoice("Whimsical", { ...env, CALLSIGN_VIBE: "ops" }, "/work/team/app", read)).toEqual({ vibe: "whimsical", source: "flag" });
    expect(resolveVibeChoice(undefined, { ...env, CALLSIGN_VIBE: "ops" }, "/work/team/app", read)).toEqual({ vibe: "ops", source: "env" });
    expect(resolveVibeChoice(undefined, env, "/work/team/app", read)).toEqual({ vibe: "whimsical", source: "repo", path: "/work/team/.callsign.json" });
    expect(resolveVibeChoice(undefined, env, "/elsewhere", read)).toEqual({ vibe: "ops", source: "user", path: "/home/me/.config/callsign/config.json" });
    expect(resolveVibeChoice(undefined, {}, "/elsewhere", () => undefined)).toEqual({ vibe: "ops", source: "default" });
    expect(() => resolveVibeChoice(undefined, env, "/x", () => ({ vibe: "grim" }))).toThrow("/x/.callsign.json");
  });
});

describe("namegen assessment", () => {
  test("flags role names, separators, digits, and unreadable spellings", () => {
    const kinds = (name: string) => callsignQualityIssues(name).map((issue) => issue.kind);
    expect(kinds("AdminBot")).toContain("authority");
    expect(kinds("Claude Helper")).toEqual(expect.arrayContaining(["authority", "separators"]));
    expect(kinds("Agent7")).toContain("digits");
    expect(kinds("Xkcdpq")).toContain("pronounceability");
    expect(kinds("Supercalifragilistic")).toEqual(expect.arrayContaining(["length", "pronounceability"]));
    expect(kinds("Pendant")).toEqual([]);
  });

  test("orders conflicts strongest first", () => {
    expect(assessCallsign("slate-harrow", ["SlateHarrier", "SlateHarrow"]).conflicts).toEqual([
      { kind: "exact", callsign: "SlateHarrow" },
      { kind: "prefix", callsign: "SlateHarrier" },
    ]);
  });
});

describe("namegen CLI", () => {
  const comments: IssueComment[] = [
    receiptComment(11, {
      status: "accepted",
      callsign: "Quillmoor",
      runId: "run_q_01",
      sessionId: "q-01",
      generation: 1,
      acceptedAt: "2026-09-24T00:00:00.000Z",
      expiresAt: "2026-09-26T00:00:00.000Z",
    }),
    receiptComment(12, {
      status: "released",
      callsign: "SlateHarrow",
      runId: "run_s_01",
      sessionId: "s-01",
      generation: 2,
      releasedAt: "2026-08-01T00:00:00.000Z",
    }),
    receiptComment(13, {
      status: "rejected",
      callsign: "NeverHeld",
      runId: "run_n_01",
      sessionId: "n-01",
      generation: null,
      reason: "active_collision:run_x",
    }),
    { id: 14, html_url: `${registryUrl}#issuecomment-14`, body: "callsign-receipt/v0\nstatus: accepted", user: { login: "teamleaderleo" } },
  ];
  const now = () => new Date("2026-09-25T00:00:00.000Z");

  test("builds the taken set from the registrar's own projection", () => {
    const wide = registrySnapshotFromComments(comments, { source: "fixture", evaluatedAt: now().toISOString(), recentDays: 90 });
    expect(wide.active.map((lease) => [lease.callsign, lease.sigil, lease.generation])).toEqual([["Quillmoor", "🌊", 1]]);
    expect(wide.taken).toEqual(["Quillmoor", "SlateHarrow"]);
    const recent = registrySnapshotFromComments(comments, { source: "fixture", evaluatedAt: now().toISOString(), recentDays: 30 });
    expect(recent.taken).toEqual(["Quillmoor"]);
    expect(recent.history).toEqual(["Quillmoor", "SlateHarrow"]);
  });

  test("propose prints a paste-ready reserve command with the derived sigil", () => {
    const args = parseNamegenArgs(["propose", "--run", "run_demo_01", "--session", "demo-01"], {});
    const { output, exitCode } = runNamegen(args, { readRegistry: () => comments, now });
    expect(exitCode).toBe(0);
    const [headline] = output.split("\n");
    const callsign = headline!.split(" ")[0]!;
    expect(headline).toBe(`${callsign} ${callsignSigil(callsign).sigil}  (collision key ${callsignCollisionKey(callsign)})`);
    expect(output).toContain(`/callsign reserve ${callsign}\nrun: run_demo_01\nsession: demo-01\nttl: 24h`);
    expect(() => parseGitHubCallsignCommand(output.slice(output.indexOf("/callsign")))).not.toThrow();
    expect(conflictKind(callsignCollisionKey(callsign), "quillmoor")).toBeNull();
  });

  test("check exits 2 on a near-collision and derive needs no registry", () => {
    const check = runNamegen(parseNamegenArgs(["check", "Kwilmoor"], {}), { readRegistry: () => comments, now });
    expect(check.exitCode).toBe(2);
    expect(check.output).toContain("conflict: phonetic with Quillmoor");

    const derive = runNamegen(parseNamegenArgs(["derive", "Teakettle", "--json"], {}), {
      readRegistry: () => {
        throw new Error("derive must not read the registry");
      },
      now,
    });
    expect(JSON.parse(derive.output)).toEqual([
      { callsign: "Teakettle", collisionKey: "teakettle", sigil: "💾", sigilSource: "derived" },
    ]);
  });

  test("offline propose skips the registry and says so", () => {
    const { output } = runNamegen(parseNamegenArgs(["--offline", "--seed", "x"], {}), {
      readRegistry: () => {
        throw new Error("offline must not read the registry");
      },
      now,
    });
    expect(output).toContain("Registry not consulted");
  });

  test("parses defaults, inline values, and the option terminator", () => {
    expect(parseNamegenArgs([], { CLAUDE_CODE_SESSION_ID: "abc" }).session).toBe("abc");
    expect(() => parseNamegenArgs(["propose", "Rook"], {})).toThrow("namegen check Rook");
    expect(parseNamegenArgs(["--run=run_a", "--count=3"], {})).toMatchObject({ run: "run_a", count: 3 });
    expect(parseNamegenArgs(["check", "--", "--odd"], {}).names).toEqual(["--odd"]);
    expect(() => parseNamegenArgs(["--bogus"], {})).toThrow("Unknown option: --bogus");
  });

  test("an invalid --avoid entry names itself", () => {
    const args = parseNamegenArgs(["--offline", "--avoid", "Foo!"], {});
    expect(() => runNamegen(args, { readRegistry: () => [], now })).toThrow('Taken name "Foo!"');
  });

  test("the CLI import graph needs only Bun and node builtins", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/^(?:import|export)[^"']*?from\s+["']([^"']+)["']/gmu)) {
        const specifier = match[1]!;
        if (specifier.startsWith("node:")) continue;
        expect({ file, specifier }).toEqual({ file, specifier: expect.stringMatching(/^\.\.?\//u) });
        visit(resolve(dirname(file), specifier.replace(/\.js$/u, ".ts")));
      }
    };
    visit(join(import.meta.dir, "../src/callsign-namegen-cli.ts"));
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});

function receiptComment(
  id: number,
  input: Partial<GitHubCallsignReceiptDraft> & { status: GitHubCallsignReceiptDraft["status"]; callsign: string },
): IssueComment {
  const draft: GitHubCallsignReceiptDraft = {
    version: 0,
    sigil: callsignSigil(input.callsign).sigil,
    collisionKey: callsignCollisionKey(input.callsign),
    requestComment: `${registryUrl}#issuecomment-${id - 10}`,
    runId: null,
    sessionId: null,
    generation: null,
    acceptedAt: null,
    expiresAt: null,
    releasedAt: null,
    reason: null,
    receiptAuthority: "github-actions[bot]",
    ...input,
  };
  return {
    id,
    html_url: `${registryUrl}#issuecomment-${id}`,
    body: formatGitHubCallsignReceipt(draft),
    user: { login: "github-actions[bot]" },
  };
}
