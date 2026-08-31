import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildNestedBubblewrapCommand,
  executeRepositoryMutation,
  executeVerification,
  registerPiLunaTools,
  resolveRepositoryPath,
  validateResult,
} from "../scripts/pi-luna-worker-extension.ts";
import {
  PI_LUNA_EXTENSION_VERSION,
  PI_LUNA_TOOL_NAMES,
  type PiLunaExtensionConfig,
} from "../scripts/pi-luna-worker-contract.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-luna-extension-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "home"));
  await mkdir(join(root, "tmp"));
  return root;
}

function config(root: string, overrides: Partial<PiLunaExtensionConfig> = {}): PiLunaExtensionConfig {
  return {
    schemaVersion: PI_LUNA_EXTENSION_VERSION,
    repository: root,
    editAuthority: "workspace-write",
    toolOutputCapBytes: 4_096,
    fileReadCapBytes: 4_096,
    toolTimeoutMs: 5_000,
    osBoundary: "none",
    bwrapBin: null,
    toolPath: "/safe/bin",
    toolHome: join(root, "home"),
    toolTmpdir: join(root, "tmp"),
    verificationExecutableDirs: ["/usr/bin"],
    verificationCommands: [],
    ...overrides,
  };
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex")}`;
}

function text(result: { readonly content: readonly [{ readonly type: "text"; readonly text: string }] }): string {
  return result.content[0].text;
}

describe("Pi Luna worker extension", () => {
  test("rejects path escapes and every symlink component", async () => {
    const root = await repository();
    const outside = await mkdtemp(join(tmpdir(), "pi-luna-outside-"));
    temporaryRoots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(outside, join(root, "link"));

    await expect(resolveRepositoryPath(root, "../secret.txt")).rejects.toThrow("escapes the repository");
    await expect(resolveRepositoryPath(root, "link/secret.txt")).rejects.toThrow("symlink repository paths are rejected");
    await expect(resolveRepositoryPath(root, "link/../secret.txt")).rejects.toThrow("symlink repository paths are rejected");
    await expect(resolveRepositoryPath(root, "new/file.txt", true)).rejects.toThrow("ENOENT");
    await expect(resolveRepositoryPath(root, "new.txt", true)).resolves.toMatchObject({
      relative: "new.txt",
      exists: false,
    });
  });

  test("registers exactly the compact typed catalogue", async () => {
    const root = await repository();
    const registered: Array<{
      readonly name: string;
      readonly parameters: Record<string, unknown>;
      readonly promptGuidelines?: unknown;
    }> = [];
    registerPiLunaTools({
      registerTool(tool) {
        registered.push(tool);
      },
    }, config(root, {
      verificationCommands: [{ id: "focused", argv: [process.execPath, "-e", "console.log('ok')"] }],
    }));

    expect(registered.map((tool) => tool.name)).toEqual([...PI_LUNA_TOOL_NAMES]);
    expect(registered).toHaveLength(6);
    expect(registered.every((tool) => !("promptGuidelines" in tool))).toBe(true);

    const git = registered.find((tool) => tool.name === "luna_repo_git");
    const mutation = registered.find((tool) => tool.name === "luna_repo_mutate");
    expect(git?.parameters.properties).toMatchObject({
      action: { enum: ["history", "status", "diff"] },
    });
    expect(mutation?.parameters.properties).toMatchObject({
      mode: { enum: ["edit", "patch"] },
    });
  });

  test("selects only the declared verification command and scrubs the environment", async () => {
    const root = await repository();
    const probePath = join(root, "verification-probe.ts");
    await writeFile(probePath, "console.log(JSON.stringify({ marker: 'selected', argv: process.argv.slice(2), keys: Object.keys(process.env).sort(), secret: process.env.PI_LUNA_SECRET ?? null, path: process.env.PATH, home: process.env.HOME, tmp: process.env.TMPDIR }))");
    const checked = config(root, {
      verificationCommands: [
        { id: "selected", argv: [process.execPath, probePath, "fixed-argument"] },
        { id: "other", argv: [process.execPath, "-e", "console.log('wrong-command')"] },
      ],
    });

    const result = await executeVerification(checked, "selected");
    const observed = JSON.parse(text(result).trim()) as {
      readonly marker: string;
      readonly argv: readonly string[];
      readonly keys: readonly string[];
      readonly secret: string | null;
      readonly path: string;
      readonly home: string;
      readonly tmp: string;
    };
    expect(observed.marker).toBe("selected");
    expect(observed.argv).toEqual(["fixed-argument"]);
    expect(observed.secret).toBeNull();
    expect(observed.keys).toEqual([
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_SYSTEM",
      "GIT_OPTIONAL_LOCKS",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TMPDIR",
    ]);
    expect(observed.path).toBe("/safe/bin");
    expect(observed.home).toBe(join(root, "home"));
    expect(observed.tmp).toBe(join(root, "tmp"));
    await expect(executeVerification(checked, "not-declared")).rejects.toThrow("not declared");
  });

  test("keeps verification output bounded and terminates timed-out process trees", async () => {
    const root = await repository();
    const noisy = config(root, {
      toolOutputCapBytes: 64,
      verificationCommands: [{ id: "noisy", argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(4096))"] }],
    });
    const noisyResult = await executeVerification(noisy, "noisy");
    expect(text(noisyResult).length).toBeLessThanOrEqual(64);
    expect(noisyResult.details).toMatchObject({ truncated: true, stdoutBytes: 4096 });

    const hanging = config(root, {
      toolTimeoutMs: 40,
      verificationCommands: [{ id: "hang", argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] }],
    });
    const timeoutResult = await executeVerification(hanging, "hang");
    expect(timeoutResult.isError).toBe(true);
    expect(timeoutResult.details).toMatchObject({ timedOut: true });
  });

  test("requires the current file hash and writes mutations atomically", async () => {
    const root = await repository();
    const path = join(root, "target.txt");
    const original = "before café\n";
    await writeFile(path, original);
    const checked = config(root);

    await expect(executeRepositoryMutation(checked, {
      mode: "edit",
      path: "target.txt",
      content: "wrong replacement\n",
      expectedSha256: hash("changed\n"),
    })).rejects.toThrow("expectedSha256 does not match");
    expect(await readFile(path, "utf8")).toBe(original);

    const edited = await executeRepositoryMutation(checked, {
      mode: "edit",
      path: "target.txt",
      content: "before café and after\n",
      expectedSha256: hash(original),
    });
    expect(text(edited)).toContain("edited target.txt");
    const editedContent = "before café and after\n";
    expect(await readFile(path, "utf8")).toBe(editedContent);

    const patched = await executeRepositoryMutation(checked, {
      mode: "patch",
      path: "target.txt",
      oldText: "after",
      newText: "again",
      expectedSha256: hash(editedContent),
    });
    expect(text(patched)).toContain("patched target.txt");
    expect(await readFile(path, "utf8")).toBe("before café and again\n");
    expect((await readdir(root)).some((entry) => entry.startsWith(".pi-luna-edit-"))).toBe(false);
  });

  test("validates exact bounded structured results", () => {
    const result = {
      status: "complete",
      summary: "done",
      changedPaths: ["target.txt"],
      verification: ["focused"],
      remainingLimits: [],
    } as const;
    expect(validateResult(result)).toEqual(result);
    expect(() => validateResult({ ...result, summary: "x".repeat(4_001) })).toThrow("result.summary");
    expect(() => validateResult({ ...result, verification: Array.from({ length: 101 }, () => "too many") })).toThrow("at most 100");
    expect(() => validateResult({ ...result, extra: "narration" })).toThrow("unexpected field");
  });

  test("builds the optional bubblewrap boundary with argv intact", async () => {
    const root = await repository();
    const checked = config(root, {
      osBoundary: "bwrap",
      bwrapBin: "/usr/bin/bwrap",
      verificationExecutableDirs: [dirname(process.execPath), "/usr/bin"],
    });
    const command = [process.execPath, "-e", "console.log('fixed')"];
    const wrapped = buildNestedBubblewrapCommand(command, checked);
    const separator = wrapped.indexOf("--");

    expect(wrapped.slice(0, 6)).toEqual([
      "/usr/bin/bwrap",
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--unshare-net",
      "--ro-bind",
    ]);
    expect(wrapped).toContain("--clearenv");
    expect(wrapped).toContain("--bind");
    expect(wrapped.slice(separator + 1)).toEqual(command);
  });
});
