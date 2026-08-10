import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMcpCapabilityPolicy } from "./mcp-capability-policy.js";

export interface SuccessfulMcpReadObservation {
  readonly toolName: string;
  readonly arguments: unknown;
}

export type SuccessfulMcpReadObserver = (
  observation: SuccessfulMcpReadObservation,
) => void | Promise<void>;

export function withSuccessfulMcpReadObservation(
  server: McpServer,
  observer?: SuccessfulMcpReadObserver,
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
        const policy = getMcpCapabilityPolicy(toolName);
        if (policy?.scope !== "read" || registrationArgs.length === 0) {
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
          const result = await Reflect.apply(handler, this, handlerArgs);
          if (isSuccessfulMcpToolResult(result)) {
            try {
              const recording = observer(Object.freeze({
                toolName,
                arguments: handlerArgs[0],
              }));
              void Promise.resolve(recording).catch(() => {});
            } catch {
              // Setup evidence is observational and cannot change tool semantics.
            }
          }
          return result;
        };
        return Reflect.apply(registerTool, target, [toolName, ...wrappedArgs]);
      };
    },
  }) as McpServer;
}

export function isSuccessfulMcpToolResult(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  let isArray: boolean;
  let content: PropertyDescriptor | undefined;
  let isError: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    content = Object.getOwnPropertyDescriptor(value, "content");
    isError = Object.getOwnPropertyDescriptor(value, "isError");
  } catch {
    return false;
  }
  if (isArray) return false;
  if (
    !content
    || !("value" in content)
    || content.enumerable !== true
    || !Array.isArray(content.value)
  ) return false;
  if (isError === undefined) return true;
  return "value" in isError
    && isError.enumerable === true
    && isError.value === false;
}
