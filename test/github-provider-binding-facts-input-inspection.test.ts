import { describe, expect, test } from "bun:test";
import { readGitHubProjectRepositoryBindingFacts } from "../src/github-provider-binding-facts.ts";
import type { GitHubProviderBindingStore } from "../src/github-provider-contracts.ts";

const repositoryFullName = "teamleaderleo/stensibly";

describe("GitHub provider binding fact input inspection", () => {
  test("uses request data descriptors without ordinary caller reads", async () => {
    let inputGets = 0;
    const input = new Proxy({
      project: "pulse",
      repositoryFullName,
    }, {
      get() {
        inputGets += 1;
        throw new Error("binding fact input get must not execute");
      },
    });
    const store = nullStore();

    const facts = await readGitHubProjectRepositoryBindingFacts(store, input);

    expect(facts.project).toBe("pulse");
    expect(facts.repositoryFullName).toBe(repositoryFullName);
    expect(facts.binding).toBeNull();
    expect(inputGets).toBe(0);
    expect(store.bindingReads).toEqual([["pulse", repositoryFullName]]);
  });

  test("rejects accessor-backed scope without getter or store activity", async () => {
    let projectReads = 0;
    const input: Record<string, unknown> = { repositoryFullName };
    Object.defineProperty(input, "project", {
      enumerable: true,
      configurable: true,
      get() {
        projectReads += 1;
        return "pulse";
      },
    });
    const store = nullStore();

    await expect(readGitHubProjectRepositoryBindingFacts(
      store,
      input as unknown as { project: string; repositoryFullName: string },
    )).rejects.toThrow("input field project");
    expect(projectReads).toBe(0);
    expect(store.bindingReads).toEqual([]);
  });
});

function nullStore(): GitHubProviderBindingStore & {
  bindingReads: Array<[string, string]>;
} {
  return {
    bindingReads: [],
    async getGitHubProjectRepositoryBinding(project, repository) {
      this.bindingReads.push([project, repository]);
      return null;
    },
    async getGitHubProviderConnection() {
      return null;
    },
  };
}
