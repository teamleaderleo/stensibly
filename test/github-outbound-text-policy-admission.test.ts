import { describe, expect, test } from "bun:test";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";
import {
  evaluateGitHubOutboundText,
  parseGitHubOutboundTextReceipt,
  type GitHubOutboundTextInput,
} from "../src/github-outbound-text-policy.ts";

function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function authorityFingerprint(
  generation: number,
  repositories: readonly string[],
): string {
  return fingerprintCanonicalRequest({
    policy: "github-external-contact-authority/v1",
    generation,
    repositories,
  });
}

function input(
  overrides: Partial<GitHubOutboundTextInput> = {},
): GitHubOutboundTextInput {
  return {
    workspace: "default",
    project: "github-provider",
    destination: { owner: "teamleaderleo", repository: "stensibly" },
    surface: "comment",
    operationRef: "github-comment-operation-review",
    authorityGeneration: 3,
    fields: [{ name: "body", text: "Local coordination remains quiet." }],
    policy: {
      version: 1,
      controlledOwners: ["teamleaderleo"],
      controlledRepositories: [],
    },
    externalContactAuthority: null,
    ...overrides,
  };
}

describe("outbound GitHub text exact admission", () => {
  test("rejects top-level and nested accessors without invocation", () => {
    let topReads = 0;
    const top = { ...input() } as Record<string, unknown>;
    Object.defineProperty(top, "workspace", {
      enumerable: true,
      get() {
        topReads += 1;
        return "default";
      },
    });
    expect(() => evaluateGitHubOutboundText(top)).toThrow(
      "only enumerable data properties",
    );
    expect(topReads).toBe(0);

    let nestedReads = 0;
    const destination = {
      owner: "teamleaderleo",
      repository: "stensibly",
    } as Record<string, unknown>;
    Object.defineProperty(destination, "owner", {
      enumerable: true,
      get() {
        nestedReads += 1;
        return "teamleaderleo";
      },
    });
    expect(() =>
      evaluateGitHubOutboundText({ ...input(), destination })
    ).toThrow("only enumerable data properties");
    expect(nestedReads).toBe(0);
  });

  test("rejects inherited, hidden, and symbol-decorated records", () => {
    const inherited = Object.assign(
      Object.create({ escapedAdmission: true }),
      input(),
    );
    expect(() => evaluateGitHubOutboundText(inherited)).toThrow(
      "plain data object",
    );

    const hidden = { ...input() } as Record<string, unknown>;
    Object.defineProperty(hidden, "escapedAdmission", {
      enumerable: false,
      value: true,
    });
    expect(() => evaluateGitHubOutboundText(hidden)).toThrow(
      "only enumerable data properties",
    );

    const decorated = { ...input(), [Symbol("escapedAdmission")]: true };
    expect(() => evaluateGitHubOutboundText(decorated)).toThrow(
      "only enumerable data properties",
    );
  });

  test("rejects sparse, accessor-backed, and decorated field arrays", () => {
    const sparse = new Array(1) as GitHubOutboundTextInput["fields"];
    expect(() => evaluateGitHubOutboundText(input({ fields: sparse }))).toThrow(
      "dense undecorated array",
    );

    let reads = 0;
    const accessorFields: unknown[] = [];
    Object.defineProperty(accessorFields, "0", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return { name: "body", text: "quiet" };
      },
    });
    expect(() =>
      evaluateGitHubOutboundText(
        input({ fields: accessorFields as GitHubOutboundTextInput["fields"] }),
      )
    ).toThrow("dense undecorated array");
    expect(reads).toBe(0);

    const decorated = [{ name: "body", text: "quiet" }];
    Object.defineProperty(decorated, "escapedAdmission", {
      enumerable: true,
      value: true,
    });
    expect(() =>
      evaluateGitHubOutboundText(
        input({ fields: decorated as GitHubOutboundTextInput["fields"] }),
      )
    ).toThrow("dense undecorated array");
  });

  test("applies dense-array admission to policy repository sets", () => {
    let reads = 0;
    const owners: unknown[] = [];
    Object.defineProperty(owners, "0", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return "teamleaderleo";
      },
    });
    expect(() =>
      evaluateGitHubOutboundText(
        input({
          policy: {
            version: 1,
            controlledOwners: owners as string[],
            controlledRepositories: [],
          },
        }),
      )
    ).toThrow("dense undecorated array");
    expect(reads).toBe(0);
  });

  test("rejects silently normalized identities and mismatched authority generation", () => {
    expect(() =>
      evaluateGitHubOutboundText(input({ workspace: " Default" }))
    ).toThrow("bounded lowercase slug");
    expect(() =>
      evaluateGitHubOutboundText(
        input({
          destination: { owner: "TeamLeaderLeo", repository: "Stensibly" },
        }),
      )
    ).toThrow("identity is not canonical");
    expect(() =>
      evaluateGitHubOutboundText(input({ operationRef: "operation-review " }))
    ).toThrow("is invalid");
    expect(() =>
      evaluateGitHubOutboundText(
        input({
          fields: [{ name: "body", text: "external/project#1" }],
          externalContactAuthority: {
            fingerprint: authorityFingerprint(2, ["external/project"]),
            generation: 2,
            repositories: ["external/project"],
          },
        }),
      )
    ).toThrow("authority generation");
  });

  test("rejects reachable credential families and permits benign identifiers", () => {
    for (const operationRef of [
      `ghp_${"a".repeat(24)}`,
      `github_pat_${"a".repeat(24)}`,
      `sk-${"a".repeat(24)}`,
      `sk-proj-${"a".repeat(24)}`,
      `stn.tok_${"a".repeat(24)}`,
      `xoxb-${"a".repeat(20)}`,
      `env://TOKEN_${"a".repeat(20)}`,
      `secret://token-${"a".repeat(20)}`,
      `eyJ${"a".repeat(10)}.eyJ${"a".repeat(10)}.${"a".repeat(10)}`,
    ]) {
      expect(() =>
        evaluateGitHubOutboundText(input({ operationRef }))
      ).toThrow("is invalid");
    }

    expect(
      evaluateGitHubOutboundText(
        input({ operationRef: "task-sk-review" }),
      ).operationRef,
    ).toBe("task-sk-review");
  });

  test("applies descriptor-safe admission to receipt parsing", () => {
    const receipt = JSON.parse(
      JSON.stringify(evaluateGitHubOutboundText(input())),
    ) as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(receipt, "decision", {
      enumerable: true,
      get() {
        reads += 1;
        return "allow";
      },
    });
    expect(() => parseGitHubOutboundTextReceipt(receipt)).toThrow(
      "only enumerable data properties",
    );
    expect(reads).toBe(0);
  });
});
