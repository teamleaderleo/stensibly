import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexProjectRepositorySetupObservationLedger,
} from "../src/project-repository-setup-convex-ledger.ts";
import {
  compileProjectRepositorySetupObservation,
} from "../src/project-repository-setup-observation.ts";

class SetupCaller implements ConvexCaller {
  current: Record<string, unknown> | null = null;
  readonly history: Record<string, unknown>[] = [];
  readonly calls: Array<{
    type: "query" | "mutation";
    name: string;
    args: Record<string, unknown>;
  }> = [];

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ) {
    const name = getFunctionName(reference);
    this.calls.push({ type: "query", name, args });
    if (name === "projectRepositorySetupObservations:getCurrent") {
      return this.current;
    }
    if (name === "projectRepositorySetupObservations:listHistory") {
      return this.history.slice(0, Number(args.limit));
    }
    throw new Error(`Unexpected query ${name}`);
  }

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ) {
    const name = getFunctionName(reference);
    this.calls.push({ type: "mutation", name, args });
    if (name !== "projectRepositorySetupObservations:record") {
      throw new Error(`Unexpected mutation ${name}`);
    }
    const observation = compileProjectRepositorySetupObservation({
      project: args.project,
      repositoryFullName: args.repositoryFullName,
      defaultBranch: args.defaultBranch,
      sourceKind: args.sourceKind,
      observedAt: args.observedAt,
    });
    const replacedFingerprint = this.current?.fingerprint ?? null;
    this.current = observation as unknown as Record<string, unknown>;
    this.history.unshift(this.current);
    return {
      observation,
      replayed: false,
      replacedFingerprint,
    };
  }
}

const base = {
  project: "scrapbook",
  repositoryFullName: "teamleaderleo/scrapbook",
  defaultBranch: "main",
  sourceKind: "github_conversation_context" as const,
  observedAt: "2026-08-10T00:30:00.000Z",
  expectedCurrentFingerprint: null,
};

describe("Convex pre-attachment repository setup observation ledger", () => {
  test("records through project-scoped query then CAS mutation", async () => {
    const client = new SetupCaller();
    const ledger = new ConvexProjectRepositorySetupObservationLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });

    const result = await ledger.recordProjectRepositorySetupObservation(base);
    expect(result.replayed).toBe(false);
    expect(result.observation.repositoryFullName).toBe("teamleaderleo/scrapbook");
    expect(client.calls.map(({ type, name }) => `${type}:${name}`)).toEqual([
      "query:projectRepositorySetupObservations:getCurrent",
      "mutation:projectRepositorySetupObservations:record",
    ]);
    expect(client.calls[1]?.args).toMatchObject({
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
      project: "scrapbook",
      repositoryFullName: "teamleaderleo/scrapbook",
      defaultBranch: "main",
      expectedCurrentFingerprint: null,
    });
  });

  test("exactly replays current observation without another mutation", async () => {
    const client = new SetupCaller();
    client.current = compileProjectRepositorySetupObservation(base) as unknown as Record<string, unknown>;
    const ledger = new ConvexProjectRepositorySetupObservationLedger({
      client,
      serviceSecret: "private-service-secret",
    });

    const replay = await ledger.recordProjectRepositorySetupObservation({
      ...base,
      expectedCurrentFingerprint: String(client.current.fingerprint),
    });
    expect(replay.replayed).toBe(true);
    expect(client.calls.map(({ type, name }) => `${type}:${name}`)).toEqual([
      "query:projectRepositorySetupObservations:getCurrent",
    ]);
  });

  test("uses current fingerprint for explicit replacement and admits history", async () => {
    const client = new SetupCaller();
    const first = compileProjectRepositorySetupObservation(base);
    client.current = first as unknown as Record<string, unknown>;
    client.history.push(client.current);
    const ledger = new ConvexProjectRepositorySetupObservationLedger({
      client,
      serviceSecret: "private-service-secret",
    });

    const replacement = await ledger.recordProjectRepositorySetupObservation({
      ...base,
      defaultBranch: "develop",
      observedAt: "2026-08-10T00:31:00.000Z",
      expectedCurrentFingerprint: first.fingerprint,
    });
    expect(replacement.replacedFingerprint).toBe(first.fingerprint);
    expect(replacement.observation.defaultBranch).toBe("develop");

    const history = await ledger.listProjectRepositorySetupObservationHistory(
      "scrapbook",
      10,
    );
    expect(history.map(({ defaultBranch }) => defaultBranch)).toEqual([
      "develop",
      "main",
    ]);
  });

  test("fails closed on a mismatched hosted response", async () => {
    const client = new SetupCaller();
    const originalMutation = client.mutation.bind(client);
    client.mutation = async (reference, args) => {
      const value = await originalMutation(reference, args) as Record<string, unknown>;
      return { ...value, replayed: true };
    };
    const ledger = new ConvexProjectRepositorySetupObservationLedger({
      client,
      serviceSecret: "private-service-secret",
    });

    await expect(ledger.recordProjectRepositorySetupObservation(base))
      .rejects.toThrow("does not match request");
  });
});
