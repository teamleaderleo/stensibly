import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  buildApplicationWorkBindingV1,
  type ApplicationWorkBindingV1,
} from "./application-lane-binding.js";
import {
  ApplicationLaneBindingStorageError,
  canonicalApplicationWorkBindingInputJson,
  exactApplicationLaneBindingId,
  exactApplicationLaneBindingItemId,
  exactApplicationLaneBindingProject,
  parseApplicationWorkBindingInputJson,
  type ApplicationLaneBindingStore,
  type BindApplicationLaneInput,
  type RetireApplicationLaneBindingInput,
} from "./application-lane-binding-store.js";

const bindRef = makeFunctionReference<"mutation">("applicationLaneBindings:bind");
const getRef = makeFunctionReference<"query">("applicationLaneBindings:get");
const listCurrentRef = makeFunctionReference<"query">(
  "applicationLaneBindings:listCurrent",
);
const historyRef = makeFunctionReference<"query">("applicationLaneBindings:history");
const retireRef = makeFunctionReference<"mutation">("applicationLaneBindings:retire");

export interface ConvexApplicationLaneBindingStoreOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export class ConvexApplicationLaneBindingStore
  implements ApplicationLaneBindingStore {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexApplicationLaneBindingStoreOptions) {
    this.client = options.client;
    this.serviceSecret = exactText(options.serviceSecret, "Convex service secret", 1_000);
    this.workspace = exactSlug(options.workspace ?? "default", "Workspace");
  }

  async bindApplicationLane(
    input: BindApplicationLaneInput,
  ): Promise<ApplicationWorkBindingV1> {
    let binding: ApplicationWorkBindingV1;
    try {
      binding = buildApplicationWorkBindingV1(input.binding);
    } catch {
      throw new ApplicationLaneBindingStorageError();
    }
    const project = exactApplicationLaneBindingProject(binding.project);
    const raw = await this.client.mutation(bindRef, this.args({
      project,
      bindingJson: canonicalApplicationWorkBindingInputJson(binding),
      idempotencyKey: exactText(
        input.idempotencyKey,
        "Application lane binding idempotency key",
        240,
      ),
    }));
    const stored = parseStoredBinding(raw);
    if (
      stored.project !== project
      || stored.id !== binding.id
      || canonicalApplicationWorkBindingInputJson(stored)
        !== canonicalApplicationWorkBindingInputJson(binding)
    ) {
      throw new ApplicationLaneBindingStorageError();
    }
    return stored;
  }

  async getApplicationLaneBinding(
    project: string,
    bindingId: string,
  ): Promise<ApplicationWorkBindingV1 | null> {
    const exactProject = exactApplicationLaneBindingProject(project);
    const exactId = exactApplicationLaneBindingId(bindingId);
    const raw = await this.client.query(getRef, this.args({
      project: exactProject,
      bindingId: exactId,
    }));
    if (raw === null) return null;
    const binding = parseStoredBinding(raw);
    if (binding.project !== exactProject || binding.id !== exactId) {
      throw new ApplicationLaneBindingStorageError();
    }
    return binding;
  }

  async listCurrentApplicationLaneBindings(
    project: string,
    itemId: string,
  ): Promise<readonly ApplicationWorkBindingV1[]> {
    const exactProject = exactApplicationLaneBindingProject(project);
    const exactItem = exactApplicationLaneBindingItemId(itemId);
    const raw = await this.client.query(listCurrentRef, this.args({
      project: exactProject,
      itemId: exactItem,
    }));
    if (!Array.isArray(raw)) throw new ApplicationLaneBindingStorageError();
    const bindings = raw.map(parseStoredBinding);
    if (bindings.some((binding) =>
      binding.project !== exactProject
      || binding.itemId !== exactItem
      || binding.retiredAt !== null
    )) {
      throw new ApplicationLaneBindingStorageError();
    }
    return Object.freeze(bindings);
  }

  async listApplicationLaneBindingHistory(
    project: string,
    bindingId: string,
  ): Promise<readonly ApplicationWorkBindingV1[]> {
    const exactProject = exactApplicationLaneBindingProject(project);
    const exactId = exactApplicationLaneBindingId(bindingId);
    const raw = await this.client.query(historyRef, this.args({
      project: exactProject,
      bindingId: exactId,
    }));
    if (!Array.isArray(raw)) throw new ApplicationLaneBindingStorageError();
    const bindings = raw.map(parseStoredBinding);
    if (bindings.some((binding) =>
      binding.project !== exactProject || binding.id !== exactId
    )) {
      throw new ApplicationLaneBindingStorageError();
    }
    for (let index = 0; index < bindings.length; index += 1) {
      if (bindings[index]!.generation !== index + 1) {
        throw new ApplicationLaneBindingStorageError();
      }
    }
    return Object.freeze(bindings);
  }

  async retireApplicationLaneBinding(
    input: RetireApplicationLaneBindingInput,
  ): Promise<ApplicationWorkBindingV1> {
    const project = exactApplicationLaneBindingProject(input.project);
    const bindingId = exactApplicationLaneBindingId(input.bindingId);
    const raw = await this.client.mutation(retireRef, this.args({
      project,
      bindingId,
      expectedGeneration: input.expectedGeneration,
      retiredAt: input.retiredAt,
      idempotencyKey: exactText(
        input.idempotencyKey,
        "Application lane binding idempotency key",
        240,
      ),
    }));
    const binding = parseStoredBinding(raw);
    if (
      binding.project !== project
      || binding.id !== bindingId
      || binding.retiredAt === null
      || binding.generation !== input.expectedGeneration + 1
    ) {
      throw new ApplicationLaneBindingStorageError();
    }
    return binding;
  }

  private args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      workspace: this.workspace,
      serviceSecret: this.serviceSecret,
    };
  }
}

export function withConvexApplicationLaneBindingStore<T extends object>(
  target: T,
  options: ConvexApplicationLaneBindingStoreOptions,
): T & ApplicationLaneBindingStore {
  const service = new ConvexApplicationLaneBindingStore(options);
  return Object.assign(target, {
    bindApplicationLane: service.bindApplicationLane.bind(service),
    getApplicationLaneBinding: service.getApplicationLaneBinding.bind(service),
    listCurrentApplicationLaneBindings:
      service.listCurrentApplicationLaneBindings.bind(service),
    listApplicationLaneBindingHistory:
      service.listApplicationLaneBindingHistory.bind(service),
    retireApplicationLaneBinding: service.retireApplicationLaneBinding.bind(service),
  });
}

function parseStoredBinding(value: unknown): ApplicationWorkBindingV1 {
  if (typeof value !== "string") throw new ApplicationLaneBindingStorageError();
  try {
    return parseApplicationWorkBindingInputJson(value);
  } catch {
    throw new ApplicationLaneBindingStorageError();
  }
}

function exactSlug(value: string, label: string): string {
  const text = exactText(value, label, 80);
  if (!/^[a-z0-9][a-z0-9-_]*$/u.test(text)) {
    throw new RangeError(`${label} must be a lowercase slug`);
  }
  return text;
}

function exactText(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}
