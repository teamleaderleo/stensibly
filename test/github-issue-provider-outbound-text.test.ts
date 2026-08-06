import { describe, expect, test } from "bun:test";
import type {
  GitHubProviderReceipt,
  GitHubProviderRequestContext,
} from "../src/github-provider-contracts.js";
import type { GitHubIssueProviderWriteService } from "../src/github-issue-provider-mcp.js";
import {
  GitHubOutboundTextPreflightError,
  GitHubOutboundTextPreflightWriteService,
} from "../src/github-issue-provider.js";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  type GitHubOutboundTextPolicyV1,
} from "../src/github-outbound-text-preflight.js";

const repository = "teamleaderleo/stensibly";
const context: GitHubProviderRequestContext = {
  project: "github-dogfood",
  repository,
  actorId: "api-token:writer",
  clientId: "mcp:api-token:writer",
};
const receipt = Object.freeze({ id: "receipt-1" }) as unknown as GitHubProviderReceipt;
type CreateIssueInput = Parameters<
  GitHubIssueProviderWriteService["createIssue"]
>[0];

describe("GitHub issue-create outbound text preflight", () => {
  test("checks and delegates the exact provider-bound title and body", async () => {
    const { service, calls } = recordingService();
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy("reject"),
    );
    const input = {
      ...context,
      title: "  Document the internal release path  ",
      body: "Line one\r\nUse teamleaderleo/stensibly#573 as the tracked internal owner.",
      labels: ["area:github"],
      assignees: ["teamleaderleo"],
      capabilityGrantId: "grant:outbound-safe-create-1",
      approvalId: "approval:outbound-safe-create-1",
      idempotencyKey: "outbound-safe-create-1",
    };

    expect(await guarded.createIssue(input)).toBe(receipt);
    expect(calls).toEqual([{
      operation: "create",
      input: {
        ...input,
        title: "Document the internal release path",
        body: "Line one\nUse teamleaderleo/stensibly#573 as the tracked internal owner.",
      },
    }]);
  });

  test("rejects create input accessors without invocation or delegation", async () => {
    const { service, calls } = recordingService();
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy("reject"),
    );
    let bodyReads = 0;
    const input = {
      ...context,
      title: "Prepare the release note",
      idempotencyKey: "outbound-hostile-body-accessor-1",
    } as Record<string, unknown>;
    Object.defineProperty(input, "body", {
      enumerable: true,
      get() {
        bodyReads += 1;
        return bodyReads === 1 ? undefined : "Fixes outside/example#42";
      },
    });

    await expect(
      guarded.createIssue(input as unknown as CreateIssueInput),
    ).rejects.toThrow(
      "GitHub issue create input fields must be enumerable data properties",
    );
    expect(bodyReads).toBe(0);
    expect(calls).toEqual([]);
  });

  test("uses descriptor values instead of caller get traps", async () => {
    const { service, calls } = recordingService();
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy("reject"),
    );
    const input = {
      ...context,
      title: "  Prepare the internal release note  ",
      body: "Line one\r\nUse teamleaderleo/stensibly#573.",
      idempotencyKey: "outbound-create-descriptor-snapshot-1",
    };
    let getCalls = 0;
    const hostile = new Proxy(input, {
      get(target, key, receiver) {
        if (key === "repository" || key === "title" || key === "body") {
          getCalls += 1;
          return key === "repository"
            ? "outside/example"
            : "Fixes outside/example#42";
        }
        return Reflect.get(target, key, receiver);
      },
    });

    expect(
      await guarded.createIssue(hostile as CreateIssueInput),
    ).toBe(receipt);
    expect(getCalls).toBe(0);
    expect(calls).toEqual([{
      operation: "create",
      input: {
        ...input,
        title: "Prepare the internal release note",
        body: "Line one\nUse teamleaderleo/stensibly#573.",
      },
    }]);
  });

  test("detaches labels and assignees before delegated service activity", async () => {
    const labels = ["area:github"];
    const assignees = ["teamleaderleo"];
    let delegated: CreateIssueInput | null = null;
    const service: GitHubIssueProviderWriteService = {
      async createIssue(input) {
        labels[0] = "mutated-label";
        labels.push("late-label");
        assignees[0] = "outside-user";
        assignees.push("late-user");
        delegated = input;
        return receipt;
      },
      async updateIssue() {
        return receipt;
      },
      async addIssueComment() {
        return receipt;
      },
    };
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy("reject"),
    );

    expect(await guarded.createIssue({
      ...context,
      title: "Prepare the internal release note",
      labels,
      assignees,
      idempotencyKey: "outbound-detached-lists-1",
    })).toBe(receipt);

    expect(delegated).not.toBeNull();
    expect(delegated!.labels).toEqual(["area:github"]);
    expect(delegated!.assignees).toEqual(["teamleaderleo"]);
    expect(delegated!.labels).not.toBe(labels);
    expect(delegated!.assignees).not.toBe(assignees);
    expect(Object.isFrozen(delegated!.labels)).toBe(true);
    expect(Object.isFrozen(delegated!.assignees)).toBe(true);
  });

  test("rejects sparse and accessor-backed create lists without delegation", async () => {
    const { service, calls } = recordingService();
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy("reject"),
    );
    const sparseLabels = new Array<string>(1);
    await expect(guarded.createIssue({
      ...context,
      title: "Prepare the internal release note",
      labels: sparseLabels,
      idempotencyKey: "outbound-sparse-labels-1",
    })).rejects.toThrow(
      "GitHub issue create labels must contain dense enumerable data entries",
    );

    let getterCalls = 0;
    const hostileAssignees: string[] = [];
    Object.defineProperty(hostileAssignees, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "outside-user";
      },
    });
    hostileAssignees.length = 1;
    await expect(guarded.createIssue({
      ...context,
      title: "Prepare the internal release note",
      assignees: hostileAssignees,
      idempotencyKey: "outbound-accessor-assignees-1",
    })).rejects.toThrow(
      "GitHub issue create assignees must contain dense enumerable data entries",
    );
    expect(getterCalls).toBe(0);
    expect(calls).toEqual([]);
  });

  test("rejects an external title before delegated service or provider activity", async () => {
    const { service, calls } = recordingService();
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy("reject"),
    );
    const externalReference =
      "Review https://github.com/outside/example/issues/42 before release";

    try {
      await guarded.createIssue({
        ...context,
        title: externalReference,
        idempotencyKey: "outbound-rejected-title-1",
      });
      throw new Error("Expected outbound title rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubOutboundTextPreflightError);
      const rejected = error as GitHubOutboundTextPreflightError;
      expect(rejected.code).toBe("github_outbound_text_rejected");
      expect(rejected.message).toBe(
        "GitHub outbound text was rejected before provider dispatch",
      );
      expect(rejected.result).toMatchObject({
        decision: "reject",
        repositoryFullName: repository,
        field: "title",
        authorizesProviderMutation: false,
        authorizesExternalInteraction: false,
        grantsAuthority: false,
        findings: [{
          externalOwner: "outside",
          externalRepository: "example",
          itemNumber: 42,
          authorityRequired: false,
        }],
      });
      const retained = `${rejected.message}\n${JSON.stringify(rejected.result)}`;
      expect(retained).not.toContain(externalReference);
      expect(retained).not.toContain("https://github.com/outside/example");
      expect(retained).not.toContain("outside/example#42");
    }
    expect(calls).toEqual([]);
  });

  test("rejects an external reference created by provider title normalization", async () => {
    const { service, calls } = recordingService();
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy("reject"),
    );

    await expect(guarded.createIssue({
      ...context,
      title: "  Ｆｉｘｅｓ outside／example#42  ",
      idempotencyKey: "outbound-normalized-title-1",
    })).rejects.toMatchObject({
      name: "GitHubOutboundTextPreflightError",
      code: "github_outbound_text_rejected",
      result: {
        decision: "reject",
        field: "title",
        findings: [{
          externalOwner: "outside",
          externalRepository: "example",
          itemNumber: 42,
          rule: "external_closing_reference",
        }],
      },
    });
    expect(calls).toEqual([]);
  });

  test("checks the body after a safe title and fails closed for required authority", async () => {
    const { service, calls } = recordingService();
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy("require_authority"),
    );

    await expect(guarded.createIssue({
      ...context,
      title: "Prepare the release note",
      body: "Fixes outside/example#42",
      idempotencyKey: "outbound-authority-body-1",
    })).rejects.toMatchObject({
      name: "GitHubOutboundTextPreflightError",
      code: "github_outbound_text_authority_required",
      message: "GitHub outbound text requires explicit external-interaction authority",
      result: {
        decision: "requires_authority",
        field: "body",
        findings: [{ authorityRequired: true }],
      },
    });
    expect(calls).toEqual([]);
  });

  test("snapshots the admitted policy before caller mutation", async () => {
    const { service, calls } = recordingService();
    const controlledRepositories = [repository];
    const mutablePolicy = {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "github-dogfood-outbound-snapshot-v1",
      controlledRepositories,
      externalReferenceDisposition: "reject" as const,
    } as GitHubOutboundTextPolicyV1;
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      mutablePolicy,
    );

    const first = await rejectedCreate(
      guarded,
      "outbound-policy-snapshot-before",
    );

    controlledRepositories.unshift("outside/example");
    const mutableView = mutablePolicy as unknown as {
      controlledRepositories: string[];
      externalReferenceDisposition: "reject" | "require_authority";
    };
    mutableView.controlledRepositories = ["outside/example", repository];
    mutableView.externalReferenceDisposition = "require_authority";

    const second = await rejectedCreate(
      guarded,
      "outbound-policy-snapshot-after",
    );

    expect(first.code).toBe("github_outbound_text_rejected");
    expect(second.code).toBe("github_outbound_text_rejected");
    expect(first.result.policyFingerprint).toBe(second.result.policyFingerprint);
    expect(second.result).toMatchObject({
      decision: "reject",
      findings: [{
        externalOwner: "outside",
        externalRepository: "example",
        itemNumber: 42,
        authorityRequired: false,
      }],
      authorizesProviderMutation: false,
      authorizesExternalInteraction: false,
      grantsAuthority: false,
    });
    expect(calls).toEqual([]);
  });

  test("keeps update and comment methods unchanged", async () => {
    const { service, calls } = recordingService();
    const guarded = new GitHubOutboundTextPreflightWriteService(
      service,
      policy("reject"),
    );
    const update = {
      ...context,
      issueNumber: 573,
      expectedSourceRevision: "revision-1",
      body: "External references remain outside this first guarded path.",
      idempotencyKey: "outbound-update-control-1",
    };
    const comment = {
      ...context,
      issueNumber: 573,
      body: "External references remain outside this first guarded path.",
      idempotencyKey: "outbound-comment-control-1",
    };

    expect(await guarded.updateIssue(update)).toBe(receipt);
    expect(await guarded.addIssueComment(comment)).toBe(receipt);
    expect(calls).toEqual([
      { operation: "update", input: update },
      { operation: "comment", input: comment },
    ]);
  });
});

function policy(
  externalReferenceDisposition: "reject" | "require_authority",
): GitHubOutboundTextPolicyV1 {
  return Object.freeze({
    version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policyId: "github-dogfood-outbound-v1",
    controlledRepositories: Object.freeze([repository]),
    externalReferenceDisposition,
  });
}

async function rejectedCreate(
  guarded: GitHubOutboundTextPreflightWriteService,
  idempotencyKey: string,
): Promise<GitHubOutboundTextPreflightError> {
  try {
    await guarded.createIssue({
      ...context,
      title: "Fixes outside/example#42",
      idempotencyKey,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubOutboundTextPreflightError);
    return error as GitHubOutboundTextPreflightError;
  }
  throw new Error("Expected outbound policy snapshot rejection");
}

function recordingService(): {
  service: GitHubIssueProviderWriteService;
  calls: Array<{ operation: "create" | "update" | "comment"; input: unknown }>;
} {
  const calls: Array<{
    operation: "create" | "update" | "comment";
    input: unknown;
  }> = [];
  return {
    calls,
    service: {
      async createIssue(input) {
        calls.push({ operation: "create", input });
        return receipt;
      },
      async updateIssue(input) {
        calls.push({ operation: "update", input });
        return receipt;
      },
      async addIssueComment(input) {
        calls.push({ operation: "comment", input });
        return receipt;
      },
    },
  };
}


describe("GitHub issue-create outbound policy key budget", () => {
  test("rejects an oversized controlled repository array before ownKeys or delegation", () => {
    const { service, calls } = recordingService();
    let ownKeysCalls = 0;
    const controlledRepositories = new Proxy(
      Array.from(
        { length: 33 },
        (_, index) => `owner/repository-${index}`,
      ),
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(() => new GitHubOutboundTextPreflightWriteService(
      service,
      {
        version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
        policyId: "github-dogfood-over-limit-v1",
        controlledRepositories,
        externalReferenceDisposition: "reject",
      },
    )).toThrow("accepts at most 32 entries");
    expect(ownKeysCalls).toBe(0);
    expect(calls).toEqual([]);
  });
});
