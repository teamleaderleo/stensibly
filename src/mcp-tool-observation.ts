import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sha256, stableJson } from "./canonical-json.js";

export interface McpToolObservation {
  readonly event: "mcp.tool.complete";
  readonly requestId: string | null;
  readonly toolName: string;
  readonly outcome: "success" | "failure";
  readonly durationMs: number;
  readonly argumentsSha256: string;
  readonly resultSha256: string;
}

export type McpToolObserver = (
  observation: McpToolObservation,
) => void | Promise<void>;

export function withMcpToolObservation(
  server: McpServer,
  requestId: string | null,
  observer?: McpToolObserver,
  now: () => number = () => performance.now(),
): McpServer {
  if (!observer) return server;

  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") {
        return Reflect.get(target, property, receiver);
      }
      return (toolName: string, ...registrationArgs: unknown[]) => {
        const registerTool = Reflect.get(target, property, target) as (
          name: string,
          ...args: unknown[]
        ) => unknown;
        if (!toolName.startsWith("github_") || registrationArgs.length === 0) {
          return Reflect.apply(registerTool, target, [toolName, ...registrationArgs]);
        }
        const handlerIndex = registrationArgs.length - 1;
        const handler = registrationArgs[handlerIndex];
        if (typeof handler !== "function") {
          return Reflect.apply(registerTool, target, [toolName, ...registrationArgs]);
        }
        const wrappedArgs = registrationArgs.slice();
        wrappedArgs[handlerIndex] = async function (
          this: unknown,
          ...handlerArgs: unknown[]
        ) {
          const startedAt = now();
          let result: unknown;
          try {
            result = await Reflect.apply(handler, this, handlerArgs);
          } catch (error) {
            observe(observer, receipt(
              requestId,
              toolName,
              "failure",
              startedAt,
              now(),
              handlerArgs[0],
              { threw: true },
            ));
            throw error;
          }
          observe(observer, receipt(
            requestId,
            toolName,
            isErrorResult(result) ? "failure" : "success",
            startedAt,
            now(),
            handlerArgs[0],
            result,
          ));
          return result;
        };
        return Reflect.apply(registerTool, target, [toolName, ...wrappedArgs]);
      };
    },
  }) as McpServer;
}

function receipt(
  requestId: string | null,
  toolName: string,
  outcome: "success" | "failure",
  startedAt: number,
  endedAt: number,
  args: unknown,
  result: unknown,
): McpToolObservation {
  return Object.freeze({
    event: "mcp.tool.complete" as const,
    requestId,
    toolName,
    outcome,
    durationMs: Math.max(0, Math.round(endedAt - startedAt)),
    argumentsSha256: digest(args),
    resultSha256: digest(result),
  });
}

function digest(value: unknown): string {
  try {
    return sha256(stableJson(value ?? null));
  } catch {
    return sha256("unavailable");
  }
}

function isErrorResult(value: unknown): boolean {
  return isRecord(value) && value.isError === true;
}

function observe(observer: McpToolObserver, value: McpToolObservation): void {
  try {
    void Promise.resolve(observer(value)).catch(() => {});
  } catch {
    // Telemetry cannot change tool semantics.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
