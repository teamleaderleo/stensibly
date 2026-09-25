import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveRunId,
  proposeCallsigns,
  requireSessionId,
  withSessionLock,
  sessionKey,
  signatureBlock,
  statePath,
  slug,
  type SessionState,
} from "../src/callsign-session.js";
import type { ParsedGitHubCallsignReceipt } from "../src/github-callsign-registry.js";

function receipt(
  callsign: string,
  overrides: Partial<ParsedGitHubCallsignReceipt> = {},
): ParsedGitHubCallsignReceipt {
  return {
    version: 0,
    status: "accepted",
    commentId: 1,
    commentUrl: "https://example.invalid/1",
    callsign,
    sigil: "🪙",
    collisionKey: callsign.toLowerCase(),
    requestComment: "https://example.invalid/0",
    runId: "run_example_1",
    sessionId: "session-1",
    generation: 1,
    acceptedAt: "2026-09-23T00:00:00.000Z",
    expiresAt: "2026-09-24T00:00:00.000Z",
    releasedAt: null,
    reason: null,
    receiptAuthority: "github-actions[bot]",
    ...overrides,
  };
}

describe("slug", () => {
  test("normalizes to identifier-safe text", () => {
    expect(slug("cmux CI / land ready PRs")).toBe("cmux_ci_land_ready_prs");
  });

  test("falls back when nothing survives normalization", () => {
    expect(slug("///")).toBe("session");
    expect(slug("   ")).toBe("session");
  });

  test("bounds runaway input", () => {
    expect(slug("a".repeat(500)).length).toBe(80);
  });
});

describe("derived identifiers", () => {
  test("run id satisfies the registry grammar", () => {
    const runId = deriveRunId("cmux ci");
    expect(runId).toMatch(/^run_[A-Za-z0-9][A-Za-z0-9._:-]*$/);
    expect(runId.length).toBeLessThanOrEqual(160);
  });

  test("run ids are unique across calls", () => {
    expect(deriveRunId("same")).not.toBe(deriveRunId("same"));
  });

  test("session id satisfies the registry grammar", () => {
    const sessionId = requireSessionId("cmux ci: 01/α");
    expect(sessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
    expect(sessionId.length).toBeLessThanOrEqual(160);
  });
});

describe("proposeCallsigns", () => {
  test("never proposes a name the registry has issued", () => {
    const history = ["Capybara", "Anvil", "Quixote", "StackTrace"].map((name) => receipt(name));
    const proposed = proposeCallsigns(history, 12);
    for (const name of proposed) {
      expect(history.some((entry) => entry.callsign === name)).toBe(false);
    }
  });

  test("avoids released names too, so history stays legible", () => {
    const history = [receipt("Capybara", { status: "released", releasedAt: "2026-09-23T01:00:00.000Z" })];
    expect(proposeCallsigns(history, 12)).not.toContain("Capybara");
  });

  test("returns the requested number of distinct names", () => {
    const proposed = proposeCallsigns([], 10);
    expect(proposed).toHaveLength(10);
    expect(new Set(proposed).size).toBe(10);
  });
});

describe("signatureBlock", () => {
  test("renders the callsign, generation, sigil and run", () => {
    const state: SessionState = {
      version: 1,
      repository: "teamleaderleo/stensibly",
      issueNumber: 454,
      callsign: "Rockall",
      sigil: "🪙",
      collisionKey: "rockall",
      generation: 2,
      runId: "run_example_20260923_abcd",
      sessionId: "session-1",
      acceptedAt: "2026-09-23T00:00:00.000Z",
      expiresAt: "2026-09-24T00:00:00.000Z",
      receiptCommentUrl: "https://example.invalid/receipt",
      requestCommentUrl: "https://example.invalid/request",
    };
    expect(signatureBlock(state)).toBe("— Rockall g2 🪙\nRun: run_example_20260923_abcd");
  });
});

describe("session isolation", () => {
  const vars = ["CALLSIGN_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"];
  const saved: Record<string, string | undefined> = {};

  function clear() {
    for (const v of vars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  }
  function restore() {
    for (const v of vars) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  }

  test("reads the session id Claude Code actually sets", () => {
    clear();
    try {
      process.env.CLAUDE_CODE_SESSION_ID = "c0ed5db7-a316-5df2-a099-c9a131135628";
      expect(requireSessionId()).toBe("c0ed5db7_a316_5df2_a099_c9a131135628");
    } finally {
      restore();
    }
  });

  test("two sessions on one machine never share a state file", () => {
    clear();
    try {
      process.env.CLAUDE_CODE_SESSION_ID = "11111111-1111-1111-1111-111111111111";
      const first = statePath();
      process.env.CLAUDE_CODE_SESSION_ID = "22222222-2222-2222-2222-222222222222";
      const second = statePath();
      expect(first).not.toBe(second);
    } finally {
      restore();
    }
  });

  test("Codex sessions are keyed by the thread id Codex exports", () => {
    clear();
    try {
      process.env.CODEX_THREAD_ID = "019a2b3c-thread";
      expect(requireSessionId()).toBe("019a2b3c_thread");
      process.env.CLAUDE_CODE_SESSION_ID = "";
      expect(sessionKey()).toBe("019a2b3c-thread");
    } finally {
      restore();
    }
  });

  test("refuses to reserve without a session id instead of drawing a new name per call", () => {
    clear();
    try {
      expect(() => requireSessionId()).toThrow("CALLSIGN_SESSION_ID");
      expect(() => statePath()).toThrow("CALLSIGN_SESSION_ID");
      expect(requireSessionId("My Session")).toBe("my_session");
    } finally {
      restore();
    }
  });

});

describe("withSessionLock", () => {
  function isolated<T>(body: () => Promise<T>): Promise<T> {
    const saved = process.env.CALLSIGN_STATE_DIR;
    process.env.CALLSIGN_STATE_DIR = mkdtempSync(join(tmpdir(), "callsign-lock-"));
    return body().finally(() => {
      if (saved === undefined) delete process.env.CALLSIGN_STATE_DIR;
      else process.env.CALLSIGN_STATE_DIR = saved;
    });
  }

  test("concurrent holders in one session never overlap", () => isolated(async () => {
    let inside = 0;
    let overlapped = false;
    const hold = () => withSessionLock("s1", async () => {
      inside += 1;
      if (inside > 1) overlapped = true;
      await Bun.sleep(50);
      inside -= 1;
    });
    await Promise.all([hold(), hold(), hold()]);
    expect(overlapped).toBe(false);
    expect(existsSync(`${statePath("s1")}.lock`)).toBe(false);
  }));

  test("breaks a lock nobody has refreshed, and never removes a lock it does not own", () => isolated(async () => {
    const lockPath = `${statePath("s2")}.lock`;
    await withSessionLock("s2", async () => {
      // Another process takes over the path mid-hold; our release must leave it.
      writeFileSync(lockPath, "someone-else");
    });
    expect(existsSync(lockPath)).toBe(true);

    const old = new Date(Date.now() - 10 * 60 * 1_000);
    utimesSync(lockPath, old, old);
    let ran = false;
    await withSessionLock("s2", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  }));
});
