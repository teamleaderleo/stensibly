import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Adversarial endpoint-privacy regression (#1632 monitor path).
 *
 * Hostile --endpoint values must be refused by both real CLI entry points
 * with a nonzero exit, zero network requests, and zero echo of any hostile
 * component (userinfo, query, fragment, API path suffix, token, project, or
 * the raw argument) in combined stdout/stderr. Successful banners may show
 * only the admitted normalized base endpoint.
 */

const REPO_ROOT = join(import.meta.dir, "..");

const BRIEF_CLI = join(REPO_ROOT, "scripts", "studio-brief-monitor.ts");
const SUMMARY_CLI = join(REPO_ROOT, "scripts", "overnight-studio-summary.ts");

const USER_SENTINEL = "sentinel-user-7f3a";
const PASSWORD_SENTINEL = "sentinel-pass-9d21";
const QUERY_SENTINEL = "sentinel-query-4b8c";
const FRAGMENT_SENTINEL = "sentinel-fragment-2e6d";
const TOKEN_SENTINEL = "stn.tok_sentinel-token-1a5f";
const PROJECT_SENTINEL = "sentinel-project-8c0b";

const SENTINELS_NEVER_ECHOED = [
  USER_SENTINEL,
  PASSWORD_SENTINEL,
  QUERY_SENTINEL,
  FRAGMENT_SENTINEL,
  TOKEN_SENTINEL,
  PROJECT_SENTINEL,
] as const;

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("STENSIBLY_")) env[key] = value;
  }
  return env;
}

interface CliResult {
  readonly exitCode: number | null;
  readonly combined: string;
}

async function runMonitorCli(scriptPath: string, extraArgs: readonly string[]): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, scriptPath, ...extraArgs], {
    cwd: REPO_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, combined: `${stdout}\n${stderr}` };
}

describe("monitor CLIs refuse hostile endpoints without echoing them", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseEndpoint: string;
  let requestsObserved = 0;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () => {
        requestsObserved += 1;
        return Response.json({ items: [] });
      },
    });
    baseEndpoint = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  interface HostileVariant {
    readonly name: string;
    readonly endpoint: string;
  }

  function hostileVariants(): readonly HostileVariant[] {
    return [
      {
        name: "embedded userinfo on an otherwise-reachable host",
        endpoint: `http://${USER_SENTINEL}:${PASSWORD_SENTINEL}@127.0.0.1:${server.port}`,
      },
      {
        name: "query string",
        endpoint: `${baseEndpoint}/?${QUERY_SENTINEL}=1`,
      },
      {
        name: "fragment",
        endpoint: `${baseEndpoint}#${FRAGMENT_SENTINEL}`,
      },
      {
        name: "API path suffix",
        endpoint: `${baseEndpoint}/api/v1/items`,
      },
      {
        name: "credential-bearing non-loopback https host (smoke evidence shape)",
        endpoint: `https://${USER_SENTINEL}:${PASSWORD_SENTINEL}@127.0.0.1.example`,
      },
      {
        name: "plain http to a non-loopback host",
        endpoint: `http://127.0.0.1.example/${QUERY_SENTINEL}`,
      },
    ];
  }

  function expectContentFreeRefusal(result: CliResult, rawEndpoint: string): void {
    expect(result.exitCode).not.toBe(0);
    expect(result.combined).toMatch(/[Rr]efused endpoint configuration/);
    for (const secret of [...SENTINELS_NEVER_ECHOED, rawEndpoint]) {
      expect(result.combined).not.toContain(secret);
    }
  }

  for (const [cliName, scriptPath] of [
    ["studio-brief-monitor", BRIEF_CLI],
    ["overnight-studio-summary", SUMMARY_CLI],
  ] as const) {
    test(`${cliName}: every hostile variant exits nonzero, makes zero requests, and echoes nothing`, async () => {
      for (const variant of hostileVariants()) {
        const countBefore = requestsObserved;
        const result = await runMonitorCli(scriptPath, [
          "--endpoint",
          variant.endpoint,
          "--token",
          TOKEN_SENTINEL,
          "--project",
          PROJECT_SENTINEL,
          "--once",
        ]);
        try {
          expectContentFreeRefusal(result, variant.endpoint);
          expect(requestsObserved - countBefore).toBe(0);
        } catch (error) {
          throw new Error(
            `hostile variant "${variant.name}" was mishandled or leaked into CLI output`,
            { cause: error },
          );
        }
      }
    }, 60_000);

    test(`${cliName}: refusal output stays content-free when stdout/stderr are combined`, async () => {
      const rawEvidence = "https://user:secret@127.0.0.1.example";
      const result = await runMonitorCli(scriptPath, ["--endpoint", rawEvidence, "--once"]);
      expectContentFreeRefusal(result, rawEvidence);
      expect(result.combined).not.toMatch(/https?:\/\/[^\s]*@/);
    }, 15_000);
  }

  test("admitted endpoint banners display only the normalized base, never the raw argument", async () => {
    const countBefore = requestsObserved;
    const result = await runMonitorCli(BRIEF_CLI, ["--endpoint", `${baseEndpoint}///`, "--once"]);
    expect(result.exitCode).toBe(0);
    expect(requestsObserved - countBefore).toBe(1);
    expect(result.combined).toContain(`Endpoint: ${baseEndpoint}`);
    expect(result.combined).not.toContain(`${baseEndpoint}///`);
    for (const secret of SENTINELS_NEVER_ECHOED) {
      expect(result.combined).not.toContain(secret);
    }
  }, 15_000);
});
