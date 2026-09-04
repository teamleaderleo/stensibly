import { WORKER_VERSION_ID_HEADER } from "../src/worker-observability.ts";

export async function verifyCommanderRead(endpoint: string, project: string, token: string,
  expectedVersion: string, fetchImpl: typeof fetch = fetch) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project) || !token || !expectedVersion) throw new Error("Missing commander readback configuration");
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetchImpl(`${endpoint}/mcp`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }),
    });
    if (!response.ok || response.headers.get(WORKER_VERSION_ID_HEADER) !== expectedVersion) throw new Error("Commander readback HTTP/version mismatch");
    const text = await response.text();
    const body = JSON.parse(text);
    if (body.error || body.result?.isError || !body.result?.structuredContent?.data) throw new Error("Commander readback tool failed");
    return { data: body.result.structuredContent.data, bytes: Buffer.byteLength(text), requestId: response.headers.get("x-request-id") };
  };
  const first = await call("get_brief", { project, limit: 3 });
  if (first.data.contract !== "commander-brief/v1" || first.data.project !== project
    || first.data.status !== "current" || !/^sha256:[a-f0-9]{64}$/.test(first.data.fingerprint)
    || first.data.coverage?.execution !== "requires_current_admission") throw new Error("Commander readback contract mismatch");
  const repeat = await call("get_brief", { project, limit: 3, previousFingerprint: first.data.fingerprint });
  if (!["current", "unchanged"].includes(repeat.data.status) || repeat.data.contract !== first.data.contract
    || repeat.data.project !== project || !/^sha256:[a-f0-9]{64}$/.test(repeat.data.fingerprint)
    || repeat.data.coverage?.execution !== "requires_current_admission"
    || (repeat.data.status === "unchanged" && repeat.data.fingerprint !== first.data.fingerprint)) throw new Error("Commander repeat contract mismatch");
  const row = [...(first.data.attention ?? []), ...first.data.blocked, ...first.data.active, ...first.data.ready, ...(first.data.recentlyCompleted ?? [])][0];
  let expanded = false;
  if (row) {
    const detail = await call("get_runner_context", { id: row.id });
    if (detail.data.item?.id !== row.id) throw new Error("Commander expansion identity mismatch");
    expanded = true;
  }
  // Retain no work prose, provider payloads or credentials in deployment logs.
  return { endpoint, project, version: expectedVersion, contract: first.data.contract,
    fingerprint: first.data.fingerprint, firstBytes: first.bytes, repeatBytes: repeat.bytes,
    repeatStatus: repeat.data.status, expanded, reads: sequence, requestId: first.requestId };
}

if (import.meta.main) {
  try {
    for (const endpoint of ["https://api.stensibly.com", "https://stensibly-api.leoli-082000.workers.dev"]) {
      console.log(JSON.stringify(await verifyCommanderRead(endpoint, process.env.VERIFY_PROJECT || "stensibly",
        process.env.STENSIBLY_TOKEN ?? "", process.env.EXPECTED_WORKER_VERSION ?? "")));
    }
  } catch {
    console.error("Commander production readback failed; inspect protected endpoint/version/tool state.");
    process.exitCode = 1;
  }
}
