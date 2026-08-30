import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  LazyOwnerProfileClientV1,
  PreparedLazyWorkstationCommandV1,
} from "./lazy-workstation-adapter.js";
import { sha256Hex } from "./sha256.js";

const MAX_DIAGNOSTIC_CHARACTERS = 64_000;

/** Executes Lazy's checked owner-profile harness without exposing raw results. */
export class LazyOwnerProfileSubprocessClientV1 implements LazyOwnerProfileClientV1 {
  readonly #python: string;
  readonly #script: string;
  readonly #profiles: string;
  readonly #outputRoot: string;

  constructor(input: {
    python?: string;
    script: string;
    profiles: string;
    outputRoot: string;
  }) {
    this.#python = input.python ?? "python3";
    this.#script = resolve(input.script);
    this.#profiles = resolve(input.profiles);
    this.#outputRoot = resolve(input.outputRoot);
    mkdirSync(this.#outputRoot, { recursive: true, mode: 0o700 });
  }

  async check(input: {
    profileId: string;
    commandId: string;
    parameters: Readonly<Record<string, string>>;
  }): Promise<unknown> {
    return await this.#invoke("check", input.profileId, input.commandId, input.parameters);
  }

  async observe(input: PreparedLazyWorkstationCommandV1): Promise<unknown> {
    return await this.#invoke(
      "run",
      input.profile.profileId,
      input.commandId,
      input.profile.parameters,
      input.checkedProfile.profileSha256,
    );
  }

  async #invoke(
    mode: "check" | "run",
    profileId: string,
    commandId: string,
    parameters: Readonly<Record<string, string>>,
    expectedProfileSha256?: string,
  ): Promise<unknown> {
    const outputDirectory = resolve(
      this.#outputRoot,
      `command-${sha256Hex(commandId).slice(0, 32)}`,
    );
    const args = [
      this.#python,
      this.#script,
      mode,
      "--profiles",
      this.#profiles,
      "--profile",
      profileId,
      "--output-dir",
      outputDirectory,
    ];
    for (const [name, value] of Object.entries(parameters).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    ))) {
      args.push("--param", `${name}=${value}`);
    }
    if (mode === "run") {
      if (!expectedProfileSha256) throw new TypeError("Lazy run requires a checked profile hash");
      args.push("--expected-profile-sha256", expectedProfileSha256);
    }
    const child = Bun.spawn(args, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (
      stdout.length > MAX_DIAGNOSTIC_CHARACTERS
      || stderr.length > MAX_DIAGNOSTIC_CHARACTERS
    ) {
      throw new Error("Lazy owner-profile subprocess diagnostics exceeded their hard bound");
    }
    if (exitCode !== 0) {
      throw new Error(`Lazy owner-profile ${mode} failed: ${boundedDiagnostic(stderr || stdout)}`);
    }
    if (stderr) throw new Error("Lazy owner-profile subprocess emitted an unexpected diagnostic");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("Lazy owner-profile subprocess did not return one JSON receipt");
    }
    return parsed;
  }
}

function boundedDiagnostic(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized.slice(0, 500) || "no bounded diagnostic";
}
