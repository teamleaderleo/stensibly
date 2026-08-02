import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFetchReceiverProfile,
  assertWorkerdSelfFetchReceiverMatrix,
} from "../test/runtime/fetch-receiver-matrix.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function run(command, args) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });

  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });

  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
  }
}

async function capture(command, args) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  if (code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${code}\n${stderr}`,
    );
  }
  return stdout.trim();
}

async function verifyObservationMerkleParity() {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "stensibly-merkle-parity-"),
  );
  const bundle = join(temporaryDirectory, "observation-merkle-vector.mjs");
  try {
    await run("bun", [
      "build",
      "test/runtime/observation-merkle-vector.ts",
      "--target=node",
      "--format=esm",
      `--outfile=${bundle}`,
    ]);
    const bunVector = await capture("bun", [bundle]);
    const nodeVector = await capture("node", [bundle]);
    if (bunVector !== nodeVector) {
      throw new Error(
        `Observation Merkle vectors diverged across Bun and Node\nBun: ${bunVector}\nNode: ${nodeVector}`,
      );
    }
    console.log(bunVector);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function findWorkerdBinary() {
  const executable = process.platform === "win32" ? "workerd.exe" : "workerd";
  const candidates = [
    join(repositoryRoot, "node_modules", ".bin", executable),
    join(repositoryRoot, "node_modules", "workerd", "bin", executable),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next package layout.
    }
  }

  throw new Error(
    "workerd executable was not found; run bun install before the parity test",
  );
}

async function reservePort() {
  const server = createServer();
  const port = await new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("Could not reserve a workerd test port"));
        return;
      }
      resolvePort(address.port);
    });
  });

  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

function capnpConfig(port) {
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "outbound", worker = .outboundWorker),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:${port}", http = (), service = "main"),
  ],
);

const mainWorker :Workerd.Worker = (
  modules = [
    (name = "main.mjs", esModule = embed "main.mjs"),
  ],
  compatibilityDate = "2026-07-22",
  globalOutbound = "outbound",
);

const outboundWorker :Workerd.Worker = (
  modules = [
    (name = "outbound.mjs", esModule = embed "outbound.mjs"),
  ],
  compatibilityDate = "2026-07-22",
);
`;
}

function startWorkerd(workerdBinary, configPath) {
  const child = spawn(workerdBinary, ["serve", configPath], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";

  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      const text = chunk.toString();
      logs += text;
      process.stderr.write(text);
    });
  }

  return { child, readLogs: () => logs };
}

async function waitForWorkerd(baseUrl, child, readLogs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`workerd exited before becoming ready\n${readLogs()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The socket is not accepting requests yet.
    }
    await delay(100);
  }

  throw new Error(`workerd did not become ready\n${readLogs()}`);
}

async function readJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function stopWorkerd(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.exitCode !== null) return;
    await delay(100);
  }

  child.kill("SIGKILL");
}

async function main() {
  console.log("== Bun receiver matrix ==");
  await run("bun", [
    "test/runtime/run-fetch-receiver-matrix.mjs",
    "server-runtime",
  ]);

  console.log("== Node receiver matrix ==");
  await run("node", [
    "test/runtime/run-fetch-receiver-matrix.mjs",
    "server-runtime",
  ]);

  console.log("== Observation Merkle vector parity ==");
  await verifyObservationMerkleParity();

  const workerdBinary = await findWorkerdBinary();
  console.log("== workerd version ==");
  await run(workerdBinary, ["--version"]);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "stensibly-workerd-"));
  const mainBundle = join(temporaryDirectory, "main.mjs");
  const outboundBundle = join(temporaryDirectory, "outbound.mjs");
  const configPath = join(temporaryDirectory, "config.capnp");
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let workerd;
  try {
    console.log("== Bundle production-path Worker ==");
    await run("bun", [
      "build",
      "test/workerd/receiver-parity.worker.mjs",
      "--target=browser",
      "--format=esm",
      `--outfile=${mainBundle}`,
    ]);
    await copyFile(
      join(repositoryRoot, "test/workerd/outbound.worker.mjs"),
      outboundBundle,
    );
    await writeFile(configPath, capnpConfig(port));

    console.log("== Native workerd receiver matrix and production path ==");
    workerd = startWorkerd(workerdBinary, configPath);
    await waitForWorkerd(baseUrl, workerd.child, workerd.readLogs);

    const matrix = await readJson(baseUrl, "/matrix");
    assertFetchReceiverProfile(matrix.results, "web-idl");
    console.log(JSON.stringify(matrix, null, 2));

    const selfMatrix = await readJson(baseUrl, "/self-matrix");
    assertWorkerdSelfFetchReceiverMatrix(selfMatrix.results);
    console.log(JSON.stringify(selfMatrix, null, 2));

    const productionPath = await readJson(baseUrl, "/client");
    if (productionPath.ok !== true) {
      throw new Error(`Unexpected production-path result: ${JSON.stringify(productionPath)}`);
    }
    console.log(JSON.stringify(productionPath, null, 2));
  } finally {
    if (workerd) await stopWorkerd(workerd.child);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
