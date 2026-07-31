import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dir, "..");
const script = join(repositoryRoot, "scripts", "link-vercel-project-domain.sh");
const temporaryRoots: string[] = [];

interface CurlCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

interface ScenarioResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly CurlCall[];
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function runScenario(scenario: string): ScenarioResult {
  const root = mkdtempSync(join(tmpdir(), "stensibly-vercel-domain-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state.json");
  const fakeCurl = join(bin, "curl");
  writeFileSync(fakeCurl, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const scenario = process.env.FAKE_VERCEL_SCENARIO;
const statePath = process.env.FAKE_VERCEL_STATE;
const args = process.argv.slice(2);
let output = "";
let method = "GET";
let bodyPath = null;
let url = "";
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--output") {
    output = args[++index];
  } else if (arg === "--write-out" || arg === "--header") {
    index += 1;
  } else if (arg === "--request") {
    method = args[++index];
  } else if (arg === "--data-binary") {
    const value = args[++index];
    bodyPath = value.startsWith("@") ? value.slice(1) : null;
  } else if (!arg.startsWith("-")) {
    url = arg;
  }
}
if (!output || !url) {
  console.error("fake curl received an incomplete invocation");
  process.exit(64);
}
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { calls: [] };
const body = bodyPath ? fs.readFileSync(bodyPath, "utf8") : null;
state.calls.push({ method, url, body });
const targetCalls = state.calls.filter((call) => call.url.includes("/v9/projects/prj_target/domains/www.stensibly.com?")).length;
const apexCalls = state.calls.filter((call) => call.url.includes("/v1/domains/stensibly.com/project-domains?")).length;
let status = 500;
let response = { error: { code: "UNEXPECTED_CALL", message: url } };

const exactDomain = { name: "www.stensibly.com", projectId: "prj_target" };
const page = (projectDomains, next = null) => ({
  projectDomains,
  pagination: { count: projectDomains.length, next, prev: null },
});

if (url.includes("/v9/projects/prj_target/domains/www.stensibly.com?")) {
  if (scenario === "already" || targetCalls > 1) {
    status = 200;
    response = exactDomain;
  } else {
    status = 404;
    response = { error: { code: "not_found", message: "not attached" } };
  }
} else if (url.includes("/v1/domains/stensibly.com/project-domains?")) {
  if (scenario === "discovery-error") {
    status = 429;
    response = {
      error: {
        code: "RATE\\n::notice title=Injected::code",
        message: "retry later\\n::warning title=Injected::" + "x".repeat(400),
      },
    };
  } else if (scenario === "paginated-move") {
    status = 200;
    response = apexCalls === 1
      ? page([], 123)
      : page([{ name: "www.stensibly.com", projectId: "prj_source" }]);
  } else if (scenario === "invalid-source") {
    status = 200;
    response = page([{ name: "www.stensibly.com", projectId: "../../other" }]);
  } else {
    status = 200;
    response = scenario === "mutation-error"
      ? page([{ name: "www.stensibly.com", projectId: "prj_source" }])
      : page([]);
  }
} else if (method === "POST" && url.includes("/move?")) {
  if (scenario === "mutation-error") {
    status = 500;
    response = {
      error: {
        code: "MOVE_FAILED",
        message: "provider failed\\n::error title=Injected::" + "y".repeat(400),
      },
    };
  } else {
    status = 200;
    response = exactDomain;
  }
} else if (method === "POST" && url.includes("/v10/projects/prj_target/domains?")) {
  status = 201;
  response = exactDomain;
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(response));
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
process.stdout.write(String(status));
`);
  chmodSync(fakeCurl, 0o755);

  const result = spawnSync("bash", [script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_VERCEL_SCENARIO: scenario,
      FAKE_VERCEL_STATE: state,
      VERCEL_API_BASE_URL: "https://vercel.invalid",
      VERCEL_TOKEN: "test-token",
      VERCEL_ORG_ID: "team_test",
      VERCEL_PROJECT_ID: "prj_target",
      EXPECTED_VERCEL_PROJECT: "stensibly",
      DASHBOARD_APEX: "stensibly.com",
      DASHBOARD_HOST: "www.stensibly.com",
    },
  });
  const calls = JSON.parse(readFileSync(state, "utf8")) as {
    readonly calls: readonly CurlCall[];
  };
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: calls.calls,
  };
}

function postCalls(result: ScenarioResult): readonly CurlCall[] {
  return result.calls.filter((call) => call.method === "POST");
}

describe("Vercel canonical project-domain linker", () => {
  test("accepts an exact existing target-domain binding without mutation", () => {
    const result = runScenario("already");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already attached to stensibly");
    expect(result.calls).toHaveLength(1);
    expect(postCalls(result)).toHaveLength(0);
  });

  test("follows complete pagination before selecting one move source", () => {
    const result = runScenario("paginated-move");

    expect(result.status).toBe(0);
    expect(result.calls.some((call) => call.url.includes("until=123"))).toBe(true);
    const posts = postCalls(result);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain(
      "/v1/projects/prj_source/domains/www.stensibly.com/move?",
    );
    expect(JSON.parse(posts[0]!.body!)).toEqual({
      projectId: "prj_target",
      gitBranch: null,
    });
    expect(result.calls.at(-1)!.url).toContain(
      "/v9/projects/prj_target/domains/www.stensibly.com?",
    );
  });

  test("adds only after complete discovery proves no source project", () => {
    const result = runScenario("add");

    expect(result.status).toBe(0);
    const posts = postCalls(result);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain("/v10/projects/prj_target/domains?");
    expect(JSON.parse(posts[0]!.body!)).toEqual({
      name: "www.stensibly.com",
      gitBranch: null,
    });
  });

  test("fails closed on discovery error and bounds provider diagnostics", () => {
    const result = runScenario("discovery-error");

    expect(result.status).toBe(1);
    expect(postCalls(result)).toHaveLength(0);
    expect(result.stdout).toContain(
      "::error title=Canonical domain discovery failed::Vercel project-domain discovery failed (HTTP 429).",
    );
    expect(result.stdout).not.toContain("\n::notice title=Injected");
    expect(result.stdout).not.toContain("\n::warning title=Injected");
    const messageLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("Vercel provider message:"));
    expect(messageLine).toBeDefined();
    expect(new TextEncoder().encode(messageLine!).byteLength).toBeLessThanOrEqual(
      new TextEncoder().encode("Vercel provider message: ").byteLength + 240,
    );
  });

  test("fails closed before URL construction on invalid source project ID", () => {
    const result = runScenario("invalid-source");

    expect(result.status).toBe(1);
    expect(postCalls(result)).toHaveLength(0);
    expect(result.stdout).toContain("invalid source project identity");
    expect(result.stdout).not.toContain("../../other/domains");
  });

  test("bounds mutation errors and skips postcondition reads after failure", () => {
    const result = runScenario("mutation-error");

    expect(result.status).toBe(1);
    expect(postCalls(result)).toHaveLength(1);
    expect(result.stdout).not.toContain("\n::error title=Injected");
    const targetReads = result.calls.filter((call) =>
      call.url.includes("/v9/projects/prj_target/domains/www.stensibly.com?"),
    );
    expect(targetReads).toHaveLength(1);
  });
});
