import { describe, expect, test } from "bun:test";
import { HostedGitHubAttachmentBindingStore } from "../src/hosted-github-attachment-binding.ts";
import type {
  ProjectAttachmentLedger,
  ProjectAttachmentRecord,
} from "../src/project-attachment-ledger.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";

const project = "multi-repo";
const firstRepository = "teamleaderleo/alpha";
const secondRepository = "teamleaderleo/beta";
const foreignRepository = "another-owner/gamma";
const observedAt = "2026-08-09T00:00:00.000Z";

describe("hosted GitHub attachment binding", () => {
  test("derives deterministic bindings and the installation repository set from the accepted attachment", async () => {
    const ledger = mutableLedger(attachment([
      secondRepository,
      foreignRepository,
      "https://git.example.com/platform/delta.git",
      firstRepository,
    ]));
    const store = new HostedGitHubAttachmentBindingStore(
      ledger,
      config(),
      observedAt,
    );

    const first = await store.getGitHubProjectRepositoryBinding(
      project,
      firstRepository,
    );
    const second = await store.getGitHubProjectRepositoryBinding(
      project,
      "TeamLeaderLeo/Beta",
    );
    const connection = await store.getGitHubProviderConnection(
      store.connectionId,
    );

    expect(first).toMatchObject({
      project,
      repositoryFullName: firstRepository,
      connectionId: "ghconn_installation_98765",
      attachmentId: ledger.current?.id,
      status: "active",
    });
    expect(second).toMatchObject({
      project,
      repositoryFullName: secondRepository,
      connectionId: "ghconn_installation_98765",
    });
    expect(first?.id).not.toBe(second?.id);
    expect(connection).toMatchObject({
      id: "ghconn_installation_98765",
      accountLogin: "teamleaderleo",
      repositoryFullNames: [firstRepository, secondRepository],
      observedAt,
    });
    expect(await store.getGitHubProjectRepositoryBinding(
      project,
      foreignRepository,
    )).toBeNull();
    expect(await store.authorizesRepository(foreignRepository)).toBe(false);
  });

  test("revokes bindings and token authority immediately when the durable attachment narrows", async () => {
    const ledger = mutableLedger(attachment([
      firstRepository,
      secondRepository,
    ]));
    const store = new HostedGitHubAttachmentBindingStore(
      ledger,
      config(),
      observedAt,
    );
    expect(await store.authorizesRepository(secondRepository)).toBe(true);
    expect(await store.getGitHubProjectRepositoryBinding(
      project,
      secondRepository,
    )).not.toBeNull();

    ledger.current = attachment([firstRepository]);

    expect(await store.authorizesRepository(secondRepository)).toBe(false);
    expect(await store.getGitHubProjectRepositoryBinding(
      project,
      secondRepository,
    )).toBeNull();
    expect((await store.getGitHubProviderConnection(store.connectionId))
      ?.repositoryFullNames).toEqual([firstRepository]);
  });

  test("fails closed when the attachment disappears or the connection identity is wrong", async () => {
    const ledger = mutableLedger(null);
    const store = new HostedGitHubAttachmentBindingStore(
      ledger,
      config(),
      observedAt,
    );

    expect(await store.authorizesRepository(firstRepository)).toBe(false);
    expect(await store.getGitHubProjectRepositoryBinding(
      project,
      firstRepository,
    )).toBeNull();
    expect(await store.getGitHubProviderConnection(store.connectionId))
      .toBeNull();
    expect(await store.getGitHubProviderConnection("ghconn_installation_1"))
      .toBeNull();
  });

  test("fails closed when either backend attachment project identity is wrong", async () => {
    for (const current of [
      attachment([firstRepository], "wrong-project", project),
      attachment([firstRepository], project, "wrong-project"),
    ]) {
      const store = new HostedGitHubAttachmentBindingStore(
        mutableLedger(current),
        config(),
        observedAt,
      );

      expect(await store.getGitHubProjectRepositoryBinding(
        project,
        firstRepository,
      )).toBeNull();
      expect(await store.getGitHubProviderConnection(store.connectionId))
        .toBeNull();
      expect(await store.authorizesRepository(firstRepository)).toBe(false);
    }
  });
});

function config() {
  return {
    project,
    installationId: "98765",
    accountLogin: "teamleaderleo",
    credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
  };
}

function attachment(
  repositories: string[],
  attachmentProject = project,
  contractProject = project,
): ProjectAttachmentRecord {
  const snapshot = compileProjectContract(renderProjectContract({
    version: 1,
    project: contractProject,
    repositories,
    runnerProfiles: [],
    concurrency: { project: 1, global: 1 },
    autonomousActions: ["inspect"],
    approvalRequired: ["provider_write"],
    checks: [],
    tags: [],
    relatedProjects: [],
  }, {
    goal: "Route one project through multiple repositories.",
    boundaries: "Only accepted attachment repositories may dispatch.",
    evidenceAndHandoff: "Preserve binding and receipt identity.",
    escalation: "Fail closed when current attachment authority changes.",
  }));
  return {
    id: `attach_${snapshot.snapshotSha256.slice(-16)}`,
    project: attachmentProject,
    snapshot,
    sourceRevision: "main@multi-repo-test",
    acceptedBy: "test",
    authorityWidening: false,
    acceptedAt: "2026-08-09T00:00:00.000Z",
  };
}

function mutableLedger(initial: ProjectAttachmentRecord | null) {
  return {
    current: initial,
    async getProjectAttachment(requestedProject: string) {
      return requestedProject === project ? this.current : null;
    },
    async acceptProjectAttachment() {
      throw new Error("acceptProjectAttachment is outside this test");
    },
  } satisfies ProjectAttachmentLedger & {
    current: ProjectAttachmentRecord | null;
  };
}
