import {
  Agent,
  type FunctionTool,
} from "@openai/agents-core";
import { sha256, stableJson } from "../canonical-json.js";

const executableToolIds = new WeakMap<object, string>();
const modelRevisions = new WeakMap<object, string>();
const builtRuntimeManifests = new WeakSet<object>();
const admittedClockBases = new WeakSet<object>();

const limits = {
  agents: 32,
  toolsPerAgent: 128,
  handoffsPerAgent: 32,
  identifier: 160,
  functionSource: 100_000,
} as const;

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const exactTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const credentialShapedIdentifierPattern = /(?:^|[\s:./=,;'"()\[\]{}@#-])(?:Bearer\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|stn\.tok_|xox[baprs]-|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;

export interface OpenAIAgentsRuntimeToolManifestV1 {
  readonly name: string;
  readonly executableId: string;
  readonly descriptionDigest: string;
  readonly parametersDigest: string;
  readonly strict: boolean;
  readonly deferLoading: boolean;
  readonly invokeDigest: string;
  readonly approvalDigest: string;
  readonly enabledDigest: string;
}

export interface OpenAIAgentsRuntimeAgentManifestV1 {
  readonly name: string;
  readonly modelKind: "string" | "object";
  readonly modelIdentity: string;
  readonly instructionsDigest: string;
  readonly handoffDescriptionDigest: string;
  readonly modelSettingsDigest: string;
  readonly toolUseBehaviorDigest: string;
  readonly resetToolChoice: boolean;
  readonly tools: readonly OpenAIAgentsRuntimeToolManifestV1[];
  readonly handoffAgentNames: readonly string[];
}

export interface OpenAIAgentsRuntimeManifestV1 {
  readonly version: 1;
  readonly rootAgentName: string;
  readonly agents: readonly OpenAIAgentsRuntimeAgentManifestV1[];
  readonly fingerprint: string;
}

export interface OpenAIAgentsClockBaseV1 {
  readonly version: 1;
  readonly baseMilliseconds: number;
}

export function bindOpenAIAgentsExecutableToolV1<
  T extends FunctionTool<any, any, any>,
>(tool: T, executableIdValue: string): T {
  if (!isRecord(tool) || tool.type !== "function") {
    throw new RangeError(
      "OpenAI Agents executable identity requires a function tool",
    );
  }
  const executableId = boundedIdentifier(
    executableIdValue,
    "OpenAI Agents executable tool ID",
  );
  const existing = executableToolIds.get(tool);
  if (existing !== undefined && existing !== executableId) {
    throw new RangeError(
      "OpenAI Agents function tool is already bound to a different executable ID",
    );
  }
  executableToolIds.set(tool, executableId);
  return tool;
}

export function bindOpenAIAgentsModelV1<T extends object>(
  model: T,
  revisionValue: string,
): T {
  const revision = boundedIdentifier(
    revisionValue,
    "OpenAI Agents object model revision",
  );
  const existing = modelRevisions.get(model);
  if (existing !== undefined && existing !== revision) {
    throw new RangeError(
      "OpenAI Agents model is already bound to a different revision",
    );
  }
  modelRevisions.set(model, revision);
  return model;
}

/** Build content-minimised evidence from the actual pinned SDK graph. */
export function buildOpenAIAgentsRuntimeManifestV1(
  rootAgent: Agent<any, any>,
): OpenAIAgentsRuntimeManifestV1 {
  if (!(rootAgent instanceof Agent)) {
    throw new RangeError("OpenAI Agents runtime root must be an SDK Agent");
  }

  const queue: Agent<any, any>[] = [rootAgent];
  const seenObjects = new WeakSet<object>();
  const seenNames = new Set<string>();
  const qualifiedToolKeys = new Set<string>();
  const seenExecutableIds = new Set<string>();
  const agents: OpenAIAgentsRuntimeAgentManifestV1[] = [];

  while (queue.length > 0) {
    if (agents.length >= limits.agents) {
      throw new RangeError(
        `OpenAI Agents runtime graph exceeds ${limits.agents} agents`,
      );
    }
    const agent = queue.shift()!;
    if (seenObjects.has(agent)) continue;
    seenObjects.add(agent);

    const name = boundedIdentifier(agent.name, "OpenAI Agents runtime agent name");
    if (seenNames.has(name)) {
      throw new RangeError(
        `OpenAI Agents runtime graph duplicates agent identity ${name}`,
      );
    }
    seenNames.add(name);
    assertFirstSliceAgentPolicy(agent, name);
    const model = runtimeModelIdentity(agent.model, name);

    const tools = agent.tools.map((entry, index) => {
      if (!isRecord(entry) || entry.type !== "function") {
        throw new RangeError(
          `OpenAI Agents runtime agent ${name} tool ${index + 1} is unsupported`,
        );
      }
      const tool = entry as FunctionTool<any, any, any>;
      assertFirstSliceFunctionToolPolicy(tool, name, index);
      const toolName = boundedIdentifier(
        tool.name,
        `OpenAI Agents runtime agent ${name} tool name`,
      );
      const qualifiedKey = stableJson([name, toolName]);
      if (qualifiedToolKeys.has(qualifiedKey)) {
        throw new RangeError(
          `OpenAI Agents runtime graph duplicates qualified tool identity ${qualifiedKey}`,
        );
      }
      qualifiedToolKeys.add(qualifiedKey);

      const executableId = executableToolIds.get(tool);
      if (executableId === undefined) {
        throw new RangeError(
          `OpenAI Agents runtime tool ${qualifiedKey} lacks an executable identity`,
        );
      }
      if (seenExecutableIds.has(executableId)) {
        throw new RangeError(
          `OpenAI Agents runtime graph duplicates executable tool identity ${executableId}`,
        );
      }
      seenExecutableIds.add(executableId);

      return {
        name: toolName,
        executableId,
        descriptionDigest: digestText(
          tool.description,
          `OpenAI Agents runtime tool ${qualifiedKey} description`,
        ),
        parametersDigest: digestCanonical(
          tool.parameters,
          `OpenAI Agents runtime tool ${qualifiedKey} parameters`,
        ),
        strict: tool.strict,
        deferLoading: tool.deferLoading === true,
        invokeDigest: digestFunction(
          tool.invoke,
          `OpenAI Agents runtime tool ${qualifiedKey} invocation`,
        ),
        approvalDigest: digestFunction(
          tool.needsApproval,
          `OpenAI Agents runtime tool ${qualifiedKey} approval`,
        ),
        enabledDigest: digestFunction(
          tool.isEnabled,
          `OpenAI Agents runtime tool ${qualifiedKey} enablement`,
        ),
      } satisfies OpenAIAgentsRuntimeToolManifestV1;
    }).sort((left, right) => compareText(left.name, right.name));

    const handoffNames = new Set<string>();
    const handoffAgentNames = agent.handoffs.map((handoff, index) => {
      if (!(handoff instanceof Agent)) {
        throw new RangeError(
          `OpenAI Agents runtime agent ${name} handoff ${index + 1} is unsupported`,
        );
      }
      const handoffName = boundedIdentifier(
        handoff.name,
        `OpenAI Agents runtime agent ${name} handoff name`,
      );
      if (handoffNames.has(handoffName)) {
        throw new RangeError(
          `OpenAI Agents runtime agent ${name} duplicates handoff identity ${handoffName}`,
        );
      }
      handoffNames.add(handoffName);
      queue.push(handoff);
      return handoffName;
    }).sort(compareText);

    agents.push({
      name,
      modelKind: model.kind,
      modelIdentity: model.identity,
      instructionsDigest: digestStaticInstructions(agent.instructions, name),
      handoffDescriptionDigest: digestText(
        agent.handoffDescription,
        `OpenAI Agents runtime agent ${name} handoff description`,
      ),
      modelSettingsDigest: digestCanonical(
        agent.modelSettings,
        `OpenAI Agents runtime agent ${name} model settings`,
      ),
      toolUseBehaviorDigest: digestStaticToolUseBehavior(
        agent.toolUseBehavior,
        name,
      ),
      resetToolChoice: agent.resetToolChoice,
      tools,
      handoffAgentNames,
    });
  }

  agents.sort((left, right) => compareText(left.name, right.name));
  const body = {
    version: 1 as const,
    rootAgentName: boundedIdentifier(
      rootAgent.name,
      "OpenAI Agents runtime root agent name",
    ),
    agents,
  };
  const manifest = admitRuntimeManifest({
    ...body,
    fingerprint: sha256(stableJson(body)),
  });
  builtRuntimeManifests.add(manifest);
  return manifest;
}

/** Admit hostile checkpoint evidence and compare it with one fresh SDK build. */
export function requireOpenAIAgentsRuntimeManifestV1(
  expectedValue: unknown,
  currentValue: unknown,
): OpenAIAgentsRuntimeManifestV1 {
  const expected = admitRuntimeManifest(expectedValue);
  if (!isRecord(currentValue) || !builtRuntimeManifests.has(currentValue)) {
    throw new RangeError("OpenAI Agents current runtime manifest is invalid");
  }
  const current = currentValue as unknown as OpenAIAgentsRuntimeManifestV1;
  if (expected.fingerprint !== current.fingerprint) {
    throw new RangeError("OpenAI Agents runtime graph identity is stale");
  }
  return current;
}

/** Call the injected clock once, before any SDK/store activity, and admit its base. */
export function admitOpenAIAgentsClockBaseV1(
  now: () => Date,
  issuedAtValue: string,
): OpenAIAgentsClockBaseV1 {
  let currentTime: number;
  try {
    const current = now();
    currentTime = Date.prototype.getTime.call(current);
  } catch {
    throw invalidClock();
  }
  const issuedTime = canonicalTimestampMilliseconds(issuedAtValue);
  const baseMilliseconds = Math.max(currentTime, issuedTime);
  if (!Number.isFinite(baseMilliseconds)) throw invalidClock();
  try {
    new Date(baseMilliseconds).toISOString();
  } catch {
    throw invalidClock();
  }
  const base = Object.freeze({
    version: 1 as const,
    baseMilliseconds,
  });
  admittedClockBases.add(base);
  return base;
}

/** Derive later observation times without calling injected code again. */
export function openAIAgentsObservationTimeV1(
  base: OpenAIAgentsClockBaseV1,
  ordinal: number,
): string {
  if (
    !admittedClockBases.has(base)
    || !Number.isSafeInteger(ordinal)
    || ordinal < 0
  ) {
    throw invalidClock();
  }
  try {
    const observedAt = new Date(
      base.baseMilliseconds + ordinal,
    ).toISOString();
    if (!exactTimestampPattern.test(observedAt)) throw invalidClock();
    return observedAt;
  } catch {
    throw invalidClock();
  }
}

function runtimeModelIdentity(
  model: Agent<any, any>["model"],
  agentName: string,
): { kind: "string" | "object"; identity: string } {
  if (typeof model === "string") {
    return {
      kind: "string",
      identity: boundedIdentifier(
        model,
        `OpenAI Agents runtime agent ${agentName} model ID`,
      ),
    };
  }
  if (!isRecord(model)) {
    throw new RangeError(
      `OpenAI Agents runtime agent ${agentName} model is unsupported`,
    );
  }
  const revision = modelRevisions.get(model);
  if (revision === undefined) {
    throw new RangeError(
      `OpenAI Agents runtime agent ${agentName} object model lacks a revision`,
    );
  }
  return { kind: "object", identity: revision };
}

function assertFirstSliceAgentPolicy(agent: Agent<any, any>, name: string): void {
  if (
    !Array.isArray(agent.tools)
    || agent.tools.length > limits.toolsPerAgent
    || !Array.isArray(agent.handoffs)
    || agent.handoffs.length > limits.handoffsPerAgent
    || agent.prompt !== undefined
    || !Array.isArray(agent.mcpServers)
    || agent.mcpServers.length !== 0
    || !isRecord(agent.mcpConfig)
    || Object.keys(agent.mcpConfig).length !== 0
    || !Array.isArray(agent.inputGuardrails)
    || agent.inputGuardrails.length !== 0
    || !Array.isArray(agent.outputGuardrails)
    || agent.outputGuardrails.length !== 0
    || agent.outputType !== "text"
    || typeof agent.resetToolChoice !== "boolean"
  ) {
    throw new RangeError(
      `OpenAI Agents runtime agent ${name} uses unsupported first-slice policy`,
    );
  }
}

function assertFirstSliceFunctionToolPolicy(
  tool: FunctionTool<any, any, any>,
  agentName: string,
  index: number,
): void {
  const label = `OpenAI Agents runtime agent ${agentName} tool ${index + 1}`;
  const allowedKeys = new Set([
    "type",
    "name",
    "description",
    "parameters",
    "strict",
    "deferLoading",
    "providerData",
    "invoke",
    "needsApproval",
    "timeoutMs",
    "timeoutBehavior",
    "timeoutErrorFunction",
    "isEnabled",
    "inputGuardrails",
    "outputGuardrails",
    "customDataExtractor",
  ]);
  if (
    Object.getOwnPropertySymbols(tool).length !== 0
    || Object.keys(tool).some((key) => !allowedKeys.has(key))
    || tool.providerData !== undefined
    || "allowedCallers" in tool
    || "outputSchema" in tool
    || "errorFunction" in tool
    || tool.timeoutMs !== undefined
    || tool.timeoutBehavior !== "error_as_result"
    || tool.timeoutErrorFunction !== undefined
    || tool.customDataExtractor !== undefined
    || !Array.isArray(tool.inputGuardrails)
    || tool.inputGuardrails.length !== 0
    || !Array.isArray(tool.outputGuardrails)
    || tool.outputGuardrails.length !== 0
    || typeof tool.strict !== "boolean"
    || typeof tool.deferLoading !== "boolean"
  ) {
    throw new RangeError(`${label} uses unsupported first-slice policy`);
  }
}

function admitRuntimeManifest(value: unknown): OpenAIAgentsRuntimeManifestV1 {
  const input = strictRecord(
    value,
    "OpenAI Agents runtime manifest",
    ["version", "rootAgentName", "agents", "fingerprint"],
  );
  if (input.version !== 1) {
    throw new RangeError("OpenAI Agents runtime manifest version is invalid");
  }
  const rootAgentName = boundedIdentifier(
    input.rootAgentName,
    "OpenAI Agents runtime root agent name",
  );
  const agentValues = strictArray(
    input.agents,
    "OpenAI Agents runtime agents",
    limits.agents,
  );
  const seenNames = new Set<string>();
  const seenQualifiedToolKeys = new Set<string>();
  const seenExecutableIds = new Set<string>();
  const agents = agentValues.map((value, index) => {
    const inputAgent = strictRecord(
      value,
      `OpenAI Agents runtime agent ${index + 1}`,
      [
        "name",
        "modelKind",
        "modelIdentity",
        "instructionsDigest",
        "handoffDescriptionDigest",
        "modelSettingsDigest",
        "toolUseBehaviorDigest",
        "resetToolChoice",
        "tools",
        "handoffAgentNames",
      ],
    );
    const name = boundedIdentifier(
      inputAgent.name,
      `OpenAI Agents runtime agent ${index + 1} name`,
    );
    if (seenNames.has(name)) {
      throw new RangeError(
        `OpenAI Agents runtime graph duplicates agent identity ${name}`,
      );
    }
    seenNames.add(name);
    const modelKind = exactEnum(
      inputAgent.modelKind,
      ["string", "object"] as const,
      "OpenAI Agents model kind",
    );
    const modelIdentity = boundedIdentifier(
      inputAgent.modelIdentity,
      `OpenAI Agents runtime agent ${name} model identity`,
    );

    const tools = strictArray(
      inputAgent.tools,
      `OpenAI Agents runtime agent ${name} tools`,
      limits.toolsPerAgent,
    ).map((toolValue, toolIndex) => {
      const inputTool = strictRecord(
        toolValue,
        `OpenAI Agents runtime agent ${name} tool ${toolIndex + 1}`,
        [
          "name",
          "executableId",
          "descriptionDigest",
          "parametersDigest",
          "strict",
          "deferLoading",
          "invokeDigest",
          "approvalDigest",
          "enabledDigest",
        ],
      );
      const toolName = boundedIdentifier(
        inputTool.name,
        `OpenAI Agents runtime agent ${name} tool name`,
      );
      const qualifiedKey = stableJson([name, toolName]);
      const executableId = boundedIdentifier(
        inputTool.executableId,
        `OpenAI Agents runtime agent ${name} executable tool ID`,
      );
      if (seenQualifiedToolKeys.has(qualifiedKey)) {
        throw new RangeError(
          `OpenAI Agents runtime graph duplicates qualified tool identity ${qualifiedKey}`,
        );
      }
      if (seenExecutableIds.has(executableId)) {
        throw new RangeError(
          `OpenAI Agents runtime graph duplicates executable tool identity ${executableId}`,
        );
      }
      seenQualifiedToolKeys.add(qualifiedKey);
      seenExecutableIds.add(executableId);
      return {
        name: toolName,
        executableId,
        descriptionDigest: exactDigest(
          inputTool.descriptionDigest,
          "Description digest",
        ),
        parametersDigest: exactDigest(
          inputTool.parametersDigest,
          "Parameters digest",
        ),
        strict: exactBoolean(inputTool.strict, "Tool strictness"),
        deferLoading: exactBoolean(
          inputTool.deferLoading,
          "Tool deferred-loading flag",
        ),
        invokeDigest: exactDigest(inputTool.invokeDigest, "Invocation digest"),
        approvalDigest: exactDigest(
          inputTool.approvalDigest,
          "Approval digest",
        ),
        enabledDigest: exactDigest(
          inputTool.enabledDigest,
          "Enablement digest",
        ),
      };
    });

    const handoffNames = new Set<string>();
    const handoffAgentNames = strictArray(
      inputAgent.handoffAgentNames,
      `OpenAI Agents runtime agent ${name} handoffs`,
      limits.handoffsPerAgent,
    ).map((handoff, handoffIndex) => {
      const handoffName = boundedIdentifier(
        handoff,
        `OpenAI Agents runtime agent ${name} handoff ${handoffIndex + 1}`,
      );
      if (handoffNames.has(handoffName)) {
        throw new RangeError(
          `OpenAI Agents runtime agent ${name} duplicates handoff identity ${handoffName}`,
        );
      }
      handoffNames.add(handoffName);
      return handoffName;
    });

    return {
      name,
      modelKind,
      modelIdentity,
      instructionsDigest: exactDigest(
        inputAgent.instructionsDigest,
        "Instructions digest",
      ),
      handoffDescriptionDigest: exactDigest(
        inputAgent.handoffDescriptionDigest,
        "Handoff-description digest",
      ),
      modelSettingsDigest: exactDigest(
        inputAgent.modelSettingsDigest,
        "Model-settings digest",
      ),
      toolUseBehaviorDigest: exactDigest(
        inputAgent.toolUseBehaviorDigest,
        "Tool-use-behavior digest",
      ),
      resetToolChoice: exactBoolean(
        inputAgent.resetToolChoice,
        "Reset-tool-choice flag",
      ),
      tools,
      handoffAgentNames,
    };
  });

  const fingerprint = exactDigest(input.fingerprint, "Manifest fingerprint");
  const body = { version: 1 as const, rootAgentName, agents };
  if (fingerprint !== sha256(stableJson(body))) {
    throw new RangeError("OpenAI Agents runtime manifest fingerprint is invalid");
  }
  if (!seenNames.has(rootAgentName)) {
    throw new RangeError("OpenAI Agents runtime root agent is absent");
  }
  for (const agent of agents) {
    for (const handoffName of agent.handoffAgentNames) {
      if (!seenNames.has(handoffName)) {
        throw new RangeError(
          `OpenAI Agents runtime handoff target ${handoffName} is absent`,
        );
      }
    }
  }
  return deepFreeze({ ...body, fingerprint });
}

function strictRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new RangeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort(compareText);
  const canonicalExpected = [...expectedKeys].sort(compareText);
  if (stableJson(actualKeys) !== stableJson(canonicalExpected)) {
    throw new RangeError(`${label} fields are invalid`);
  }
  const output: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new RangeError(
        `${label} field ${key} must be an enumerable data property`,
      );
    }
    output[key] = descriptor.value;
  }
  return output;
}

function strictArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new RangeError(`${label} must be a bounded array`);
  }
  const length = value.length;
  if (length > maximum) {
    throw new RangeError(`${label} must be a bounded array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new RangeError(`${label} must use the default array prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new RangeError(`${label} contains a symbol field`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set<string>(["length"]);
  for (let index = 0; index < length; index += 1) {
    allowed.add(String(index));
  }
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
    throw new RangeError(`${label} contains an unknown field`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new RangeError(
        `${label} must contain dense enumerable data entries`,
      );
    }
    output.push(descriptor.value);
  }
  return output;
}

function canonicalTimestampMilliseconds(value: unknown): number {
  if (typeof value !== "string" || !exactTimestampPattern.test(value)) {
    throw invalidClock();
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw invalidClock();
  try {
    if (new Date(milliseconds).toISOString() !== value) throw invalidClock();
  } catch {
    throw invalidClock();
  }
  return milliseconds;
}

function invalidClock(): RangeError {
  return new RangeError("OpenAI Agents adapter clock is invalid");
}

function digestStaticInstructions(
  value: Agent<any, any>["instructions"],
  agentName: string,
): string {
  if (typeof value !== "string") {
    throw new RangeError(
      `OpenAI Agents runtime agent ${agentName} uses unsupported dynamic instructions`,
    );
  }
  return digestText(
    value,
    `OpenAI Agents runtime agent ${agentName} instructions`,
  );
}

function digestStaticToolUseBehavior(value: unknown, agentName: string): string {
  if (typeof value === "function") {
    throw new RangeError(
      `OpenAI Agents runtime agent ${agentName} uses unsupported dynamic tool-use behavior`,
    );
  }
  return digestCanonical(
    value,
    `OpenAI Agents runtime agent ${agentName} tool-use behavior`,
  );
}

function digestText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > limits.functionSource) {
    throw new RangeError(`${label} is invalid`);
  }
  return sha256(value);
}

function digestFunction(value: unknown, label: string): string {
  if (typeof value !== "function") {
    throw new RangeError(`${label} is invalid`);
  }
  let source: string;
  try {
    source = Function.prototype.toString.call(value);
  } catch {
    throw new RangeError(`${label} is invalid`);
  }
  if (source.length === 0 || source.length > limits.functionSource) {
    throw new RangeError(`${label} is invalid`);
  }
  return sha256(source);
}

function digestCanonical(value: unknown, label: string): string {
  try {
    return sha256(stableJson(value));
  } catch {
    throw new RangeError(`${label} is invalid`);
  }
}

function exactDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new RangeError(`${label} is invalid`);
  return value;
}

function exactEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > limits.identifier
    || value.trim() !== value
    || unsafeTextPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  if (credentialShapedIdentifierPattern.test(value)) {
    throw new RangeError("OpenAI Agents runtime identifier is invalid");
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
