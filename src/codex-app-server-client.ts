import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexAppServerNotification {
  readonly sequence: number;
  readonly method: string;
  readonly params: unknown;
}

export interface CodexAppServerConnection {
  request<Result>(method: string, params: unknown): Promise<Result>;
  notificationCursor(): number;
  notificationsSince(cursor: number): readonly CodexAppServerNotification[];
  waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean,
    afterCursor: number,
    timeoutMs?: number,
  ): Promise<CodexAppServerNotification>;
  close(): Promise<void>;
}

export interface CodexAppServerClientOptions {
  readonly codexBin?: string;
  readonly requestTimeoutMs?: number;
  readonly notificationLimit?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

interface PendingRequest {
  readonly method: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface NotificationWaiter {
  readonly method: string;
  readonly predicate: (params: unknown) => boolean;
  readonly afterCursor: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: CodexAppServerNotification) => void;
  readonly reject: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_NOTIFICATION_LIMIT = 512;
const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;

/**
 * A deliberately small app-server transport. It owns one local process and no
 * durable state; callers retain only bounded thread references in Stensibly.
 */
export class CodexAppServerClient implements CodexAppServerConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #requestTimeoutMs: number;
  readonly #notificationLimit: number;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #waiters = new Set<NotificationWaiter>();
  readonly #notifications: CodexAppServerNotification[] = [];
  #nextRequestId = 1;
  #notificationSequence = 0;
  #closed = false;
  #stderr = "";

  get pid(): number {
    const pid = this.#child.pid;
    if (!pid) throw new Error("Codex app-server process has no resident PID");
    return pid;
  }

  private constructor(child: ChildProcessWithoutNullStreams, options: CodexAppServerClientOptions) {
    this.#child = child;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "Codex request timeout",
    );
    this.#notificationLimit = positiveInteger(
      options.notificationLimit ?? DEFAULT_NOTIFICATION_LIMIT,
      "Codex notification limit",
    );

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#receiveLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderr = boundedTail(this.#stderr + chunk.toString(), 32_768);
    });
    child.once("error", (error) => this.#fail(new Error(`Codex app-server process failed: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (!this.#closed) {
        const detail = this.#stderr.trim();
        this.#fail(new Error(
          `Codex app-server exited (code ${String(code)}, signal ${String(signal)})${detail ? `: ${detail}` : ""}`,
        ));
      }
    });
  }

  static async connect(options: CodexAppServerClientOptions = {}): Promise<CodexAppServerClient> {
    const codexBin = safeCommand(options.codexBin ?? "codex");
    const child = spawn(codexBin, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.environment ? { ...process.env, ...options.environment } : process.env,
      detached: process.platform !== "win32",
    });
    const client = new CodexAppServerClient(child, options);
    try {
      await client.request("initialize", {
        clientInfo: {
          name: safeProtocolText(options.clientName ?? "stensibly-codex-root-harness", 160),
          title: "Stensibly Codex root harness",
          version: safeProtocolText(options.clientVersion ?? "0.1.0", 64),
        },
        capabilities: { experimentalApi: true },
      });
      client.#notify("initialized", {});
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  request<Result>(method: string, params: unknown): Promise<Result> {
    if (this.#closed) return Promise.reject(new Error("Codex app-server connection is closed"));
    const id = this.#nextRequestId++;
    const safeMethod = safeProtocolMethod(method);
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${safeMethod}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, {
        method: safeMethod,
        timer,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        this.#write({ id, method: safeMethod, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(asError(error));
      }
    });
  }

  notificationCursor(): number {
    return this.#notificationSequence;
  }

  notificationsSince(cursor: number): readonly CodexAppServerNotification[] {
    nonNegativeInteger(cursor, "Notification cursor");
    return this.#notifications.filter((notification) => notification.sequence > cursor);
  }

  waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean,
    afterCursor: number,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<CodexAppServerNotification> {
    const safeMethod = safeProtocolMethod(method);
    nonNegativeInteger(afterCursor, "Notification cursor");
    positiveInteger(timeoutMs, "Notification timeout");
    const existing = this.#notifications.find((notification) =>
      notification.sequence > afterCursor
      && notification.method === safeMethod
      && safelyMatches(predicate, notification.params)
    );
    if (existing) return Promise.resolve(existing);
    if (this.#closed) return Promise.reject(new Error("Codex app-server connection is closed"));
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        method: safeMethod,
        predicate,
        afterCursor,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`Timed out waiting for Codex notification: ${safeMethod}`));
        }, timeoutMs),
        resolve,
        reject,
      };
      this.#waiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closed = new Error("Codex app-server connection closed");
    this.#rejectPending(closed);
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      this.#signalProcessTree("SIGKILL");
      return;
    }
    this.#signalProcessTree("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => this.#child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    this.#signalProcessTree("SIGKILL");
  }

  #notify(method: string, params: unknown): void {
    this.#write({ method: safeProtocolMethod(method), params });
  }

  #write(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
      throw new RangeError("Codex app-server request exceeds the protocol line limit");
    }
    if (!this.#child.stdin.write(line)) {
      // Node buffers the write. Request timeouts remain the backpressure bound.
    }
  }

  #receiveLine(line: string): void {
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
      this.#fail(new Error("Codex app-server emitted an oversized protocol line"));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#fail(new Error("Codex app-server emitted malformed JSON"));
      return;
    }
    if (!isRecord(message)) {
      this.#fail(new Error("Codex app-server emitted a non-object message"));
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.#fail(new Error(`Codex app-server returned an unknown response ID: ${message.id}`));
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message && message.error !== undefined) {
        pending.reject(protocolError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string" && !("id" in message)) {
      this.#recordNotification(message.method, message.params);
      return;
    }
    if (typeof message.method === "string" && (typeof message.id === "number" || typeof message.id === "string")) {
      this.#write({
        id: message.id,
        error: { code: -32601, message: "Stensibly root harness does not authorize server-initiated requests" },
      });
      return;
    }
    this.#fail(new Error("Codex app-server emitted an unsupported protocol message"));
  }

  #recordNotification(method: string, params: unknown): void {
    const notification = Object.freeze({
      sequence: ++this.#notificationSequence,
      method: safeProtocolMethod(method),
      params,
    });
    this.#notifications.push(notification);
    if (this.#notifications.length > this.#notificationLimit) this.#notifications.shift();
    for (const waiter of [...this.#waiters]) {
      if (
        notification.sequence > waiter.afterCursor
        && notification.method === waiter.method
        && safelyMatches(waiter.predicate, notification.params)
      ) {
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(notification);
      }
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error);
    this.#signalProcessTree("SIGTERM");
  }

  #signalProcessTree(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") this.#child.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
      if (code !== "ESRCH") throw error;
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

function safelyMatches(predicate: (params: unknown) => boolean, params: unknown): boolean {
  try {
    return predicate(params);
  } catch {
    return false;
  }
}

function protocolError(method: string, value: unknown): Error {
  if (isRecord(value)) {
    const code = typeof value.code === "number" ? ` (${value.code})` : "";
    const message = typeof value.message === "string" ? value.message : "unknown error";
    return new Error(`Codex app-server ${method} failed${code}: ${boundedTail(message, 2_000)}`);
  }
  return new Error(`Codex app-server ${method} failed`);
}

function safeCommand(value: string): string {
  if (!value || /[\u0000\r\n]/u.test(value)) throw new RangeError("Codex executable is invalid");
  return value;
}

function safeProtocolMethod(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9/_-]{0,127}$/u.test(value)) {
    throw new RangeError("Codex protocol method is invalid");
  }
  return value;
}

function safeProtocolText(value: string, maximum: number): string {
  const output = value.trim();
  if (!output || output.length > maximum || /[\u0000-\u001f\u007f]/u.test(output)) {
    throw new RangeError("Codex protocol text is invalid");
  }
  return output;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be non-negative`);
  return value;
}

function boundedTail(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(value.length - maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
