import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexProjectRepositorySetupObservationLedger,
} from "../src/project-repository-setup-observation-convex.ts";
import {
  createProjectRepositorySetupObservationRecord,
  prepareProjectRepositorySetupObservation,
} from "../src/project-repository-setup-observation.ts";

const base = {
  project: "scrapbook",
  repositoryFullName: "teamleaderleo/scrapbook",
  defaultBranch: "main",
  sourceKind: "github_conversation_context" as const,
};
const invalidResponse = "Hosted repository setup observation response is invalid";

class SetupCaller implements ConvexCaller {
  current: ReturnType<typeof createProjectRepositorySetupObservationRecord> | null = null;
  readonly calls: string[] = [];
  readonly mutationArgs: Record<string, unknown>[] = [];
  private clock = 0;

  async query(
    reference: FunctionReference<"query">,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    const name = getFunctionName(reference);
    this.calls.push(`query:${name}`);
    if (name !== "projectRepositorySetupObservations:getCurrent") {
      throw new Error(`Unexpected query ${name}`);
    }
    return this.current;
  }

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const name = getFunctionName(reference);
    this.calls.push(`mutation:${name}`);
    this.mutationArgs.push({ ...args });
    if (name !== "projectRepositorySetupObservations:record") {
      throw new Error(`Unexpected mutation ${name}`);
    }
    const prepared = prepareProjectRepositorySetupObservation(this.current, {
      project: String(args.project),
      repositoryFullName: String(args.repositoryFullName),
      defaultBranch: String(args.defaultBranch),
      sourceKind: args.sourceKind as typeof base.sourceKind,
      ...(Object.hasOwn(args, "expectedCurrentObservationId")
        ? {
          expectedCurrentObservationId: args.expectedCurrentObservationId as string | null,
        }
        : {}),
    });
    if (
      prepared.expectedCurrentObservationId !== undefined
      && prepared.expectedCurrentObservationId !== (this.current?.id ?? null)
    ) {
      throw new Error("stale repository setup observation");
    }
    if (prepared.replay) {
      return {
        observation: prepared.replay,
        replayed: true,
        replacedObservationId: null,
      };
    }
    const replacedObservationId = this.current?.id ?? null;
    this.clock += 1;
    this.current = createProjectRepositorySetupObservationRecord({
      id: String(args.externalId),
      project: prepared.project,
      repositoryFullName: prepared.repositoryFullName,
      defaultBranch: prepared.defaultBranch,
      sourceKind: prepared.sourceKind,
      semanticFingerprint: prepared.semanticFingerprint,
      observedAt: `2026-08-10T00:3${this.clock}:00.000Z`,
    });
    return {
      observation: this.current,
      replayed: false,
      replacedObservationId,
    };
  }
}

describe("Convex repository setup observation ledger", () => {
  test("records, server-replays, then visibly replaces the current proposal", async () => {
    const client = new SetupCaller();
    const ledger = new ConvexProjectRepositorySetupObservationLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });

    const first = await ledger.recordProjectRepositorySetupObservation(base);
    expect(first.replayed).toBe(false);
    expect(first.replacedObservationId).toBeNull();
    expect(first.observation).toMatchObject({
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      authorizesProviderEffect: false,
      containsSecrets: false,
    });
    expect(client.mutationArgs[0]).not.toHaveProperty("expectedCurrentObservationId");

    const replay = await ledger.recordProjectRepositorySetupObservation(base);
    expect(replay).toEqual({
      observation: first.observation,
      replayed: true,
      replacedObservationId: null,
    });
    expect(client.calls.filter((call) => call.startsWith("mutation:"))).toHaveLength(2);

    const replacement = await ledger.recordProjectRepositorySetupObservation({
      ...base,
      defaultBranch: "develop",
    });
    expect(replacement.replayed).toBe(false);
    expect(replacement.replacedObservationId).toBe(first.observation.id);
    expect(replacement.observation.defaultBranch).toBe("develop");
    expect(await ledger.getProjectRepositorySetupObservation("scrapbook"))
      .toEqual(replacement.observation);
  });

  test("forwards null and exact-id compare-and-swap fences and rejects a stale writer", async () => {
    const client = new SetupCaller();
    const ledger = new ConvexProjectRepositorySetupObservationLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });

    const first = await ledger.recordProjectRepositorySetupObservation({
      ...base,
      expectedCurrentObservationId: null,
    });
    expect(client.mutationArgs.at(-1)?.expectedCurrentObservationId).toBeNull();

    const second = await ledger.recordProjectRepositorySetupObservation({
      ...base,
      defaultBranch: "develop",
      expectedCurrentObservationId: first.observation.id,
    });
    expect(client.mutationArgs.at(-1)?.expectedCurrentObservationId)
      .toBe(first.observation.id);

    await expect(ledger.recordProjectRepositorySetupObservation({
      ...base,
      defaultBranch: "trunk",
      expectedCurrentObservationId: first.observation.id,
    })).rejects.toThrow(invalidResponse);
    expect(client.current?.id).toBe(second.observation.id);
    expect(client.current?.defaultBranch).toBe("develop");
  });

  test("rejects a decorated hosted response before trusting it", async () => {
    const client = new SetupCaller();
    const originalMutation = client.mutation.bind(client);
    client.mutation = async (reference, args): Promise<unknown> => ({
      ...(await originalMutation(reference, args) as Record<string, unknown>),
      extra: true,
    });
    const ledger = new ConvexProjectRepositorySetupObservationLedger({
      client,
      serviceSecret: "private-service-secret",
    });
    await expect(ledger.recordProjectRepositorySetupObservation(base))
      .rejects.toThrow("response is invalid");
  });

  test("collapses revoked top-level query and mutation responses to one fixed error", async () => {
    const queryClient = new SetupCaller();
    const queryRevocable = Proxy.revocable({}, {});
    queryRevocable.revoke();
    queryClient.query = async (): Promise<unknown> => queryRevocable.proxy;
    const queryLedger = new ConvexProjectRepositorySetupObservationLedger({
      client: queryClient,
      serviceSecret: "private-service-secret",
    });
    await expect(queryLedger.getProjectRepositorySetupObservation("scrapbook"))
      .rejects.toThrow(invalidResponse);

    const mutationClient = new SetupCaller();
    const mutationRevocable = Proxy.revocable({}, {});
    mutationRevocable.revoke();
    mutationClient.mutation = async (): Promise<unknown> => mutationRevocable.proxy;
    const mutationLedger = new ConvexProjectRepositorySetupObservationLedger({
      client: mutationClient,
      serviceSecret: "private-service-secret",
    });
    await expect(mutationLedger.recordProjectRepositorySetupObservation(base))
      .rejects.toThrow(invalidResponse);
  });
});
