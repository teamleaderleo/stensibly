import { describe, expect, test } from "bun:test";
import {
  GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
  compileGitHubOutboundTextPreflightV1,
  type GitHubOutboundTextPreflightInputV1,
} from "../src/github-outbound-text-preflight.ts";

const controlledRepository = "teamleaderleo/stensibly";

describe("GitHub outbound preflight single-snapshot admission", () => {
  test("binds supplemental findings to the same text snapshot as the base result", () => {
    const stable = input("No external reference.");
    const changedText = "https://github.com:443/example/project/issues/12";
    let textDescriptorReads = 0;
    const changing = new Proxy(stable, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property !== "text" || !descriptor || !("value" in descriptor)) {
          return descriptor;
        }
        textDescriptorReads += 1;
        return {
          ...descriptor,
          value: textDescriptorReads === 1 ? stable.text : changedText,
        };
      },
    });

    const result = compileGitHubOutboundTextPreflightV1(changing);

    expect(textDescriptorReads).toBe(1);
    expect(result).toEqual(compileGitHubOutboundTextPreflightV1(stable));
    expect(result.decision).toBe("pass");
    expect(result.findings).toHaveLength(0);
  });

  test("binds supplemental disposition to the same policy snapshot as its fingerprint", () => {
    const stable = input(
      "https://github.com:443/example/project/issues/12",
      "reject",
    );
    let dispositionDescriptorReads = 0;
    const changingPolicy = new Proxy(stable.policy, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (
          property !== "externalReferenceDisposition"
          || !descriptor
          || !("value" in descriptor)
        ) {
          return descriptor;
        }
        dispositionDescriptorReads += 1;
        return {
          ...descriptor,
          value: dispositionDescriptorReads === 1
            ? "reject"
            : "require_authority",
        };
      },
    });
    const changing = {
      ...stable,
      policy: changingPolicy,
    };

    const result = compileGitHubOutboundTextPreflightV1(changing);

    expect(dispositionDescriptorReads).toBe(1);
    expect(result).toEqual(compileGitHubOutboundTextPreflightV1(stable));
    expect(result.decision).toBe("reject");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.authorityRequired).toBe(false);
  });
});

function input(
  text: string,
  externalReferenceDisposition: "reject" | "require_authority" = "reject",
): GitHubOutboundTextPreflightInputV1 {
  return {
    schemaVersion: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
    policy: {
      version: GITHUB_OUTBOUND_TEXT_PREFLIGHT_V1,
      policyId: "single-snapshot-control",
      controlledRepositories: [controlledRepository],
      externalReferenceDisposition,
    },
    repositoryFullName: controlledRepository,
    field: "comment",
    text,
  };
}
