import { describe, expect, test } from "bun:test";
import {
  GitHubProviderBindingStoreConflictError,
  SqliteGitHubProviderBindingStore,
  getSqliteGitHubProviderConnection,
  putSqliteGitHubProjectRepositoryBinding,
  putSqliteGitHubProviderConnection,
} from "../src/github-provider-binding-sqlite-store.ts";
import { StensiblyStore } from "../src/store.ts";

const attachmentFingerprint = `sha256:${"a".repeat(64)}`;

function connectionInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "github-connection:installation-42",
    provider: "github",
    installationId: "42",
    accountLogin: "TeamLeaderLeo",
    credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    status: "active",
    repositoryFullNames: [
      "TeamLeaderLeo/Zensibly",
      "https://github.com/TeamLeaderLeo/Stensibly.git",
    ],
    observedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function bindingInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "github-binding:scrapbook:stensibly:1",
    project: "scrapbook",
    repositoryFullName: "TeamLeaderLeo/Stensibly",
    connectionId: "github-connection:installation-42",
    attachmentId: "attachment:scrapbook:1",
    attachmentSnapshotSha256: attachmentFingerprint,
    status: "active",
    acceptedAt: "2026-07-31T00:01:00.000Z",
    ...overrides,
  };
}

function storeWithProject(): StensiblyStore {
  const store = new StensiblyStore(":memory:");
  store.db.query(`
    INSERT INTO projects (id, name, created_at)
    VALUES (?1, ?1, ?2)
  `).run("scrapbook", "2026-07-31T00:00:00.000Z");
  return store;
}

describe("SQLite GitHub provider binding store", () => {
  test("persists canonical immutable records behind the existing read contract", async () => {
    const store = storeWithProject();
    try {
      const bindings = new SqliteGitHubProviderBindingStore(store);
      const connection = await bindings.putGitHubProviderConnection(connectionInput());
      expect(connection.accountLogin).toBe("teamleaderleo");
      expect(connection.repositoryFullNames).toEqual([
        "teamleaderleo/stensibly",
        "teamleaderleo/zensibly",
      ]);
      expect(Object.isFrozen(connection)).toBe(true);
      expect(Object.isFrozen(connection.repositoryFullNames)).toBe(true);

      const binding = await bindings.putGitHubProjectRepositoryBinding(bindingInput());
      expect(binding.repositoryFullName).toBe("teamleaderleo/stensibly");
      expect(Object.isFrozen(binding)).toBe(true);

      expect(await bindings.getGitHubProviderConnection(connection.id)).toEqual(connection);
      expect(
        await bindings.getGitHubProjectRepositoryBinding(
          "scrapbook",
          "https://github.com/TEAMLEADERLEO/STENSIBLY.git",
        ),
      ).toEqual(binding);
    } finally {
      store.close();
    }
  });

  test("rejects a binding for a missing project without creating authority rows", () => {
    const store = new StensiblyStore(":memory:");
    try {
      putSqliteGitHubProviderConnection(store, connectionInput());
      expect(() =>
        putSqliteGitHubProjectRepositoryBinding(store, bindingInput())
      ).toThrow("Stensibly project scrapbook does not exist");
      expect(
        store.db.query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM projects",
        ).get()?.count,
      ).toBe(0);
      expect(
        store.db.query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM github_project_repository_bindings",
        ).get()?.count,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("replays exact observations and rejects same-time or stale conflicts", () => {
    const store = storeWithProject();
    try {
      const first = putSqliteGitHubProviderConnection(store, connectionInput());
      expect(putSqliteGitHubProviderConnection(store, connectionInput())).toEqual(first);
      expect(() =>
        putSqliteGitHubProviderConnection(
          store,
          connectionInput({ status: "suspended" }),
        )
      ).toThrow(GitHubProviderBindingStoreConflictError);

      putSqliteGitHubProviderConnection(
        store,
        connectionInput({
          status: "suspended",
          observedAt: "2026-07-31T00:02:00.000Z",
        }),
      );
      expect(putSqliteGitHubProviderConnection(store, connectionInput())).toEqual(first);
      expect(() =>
        putSqliteGitHubProviderConnection(
          store,
          connectionInput({ observedAt: "2026-07-31T00:01:00.000Z" }),
        )
      ).toThrow("predates");
    } finally {
      store.close();
    }
  });

  test("returns the latest status under one stable connection identity", async () => {
    const store = storeWithProject();
    try {
      const bindings = new SqliteGitHubProviderBindingStore(store);
      await bindings.putGitHubProviderConnection(connectionInput());
      await bindings.putGitHubProjectRepositoryBinding(bindingInput());

      const suspended = await bindings.putGitHubProviderConnection(
        connectionInput({
          status: "suspended",
          observedAt: "2026-07-31T00:02:00.000Z",
        }),
      );
      expect(await bindings.getGitHubProviderConnection(suspended.id)).toEqual(suspended);
      await expect(
        bindings.putGitHubProjectRepositoryBinding(
          bindingInput({
            id: "github-binding:scrapbook:zensibly:1",
            repositoryFullName: "teamleaderleo/zensibly",
            acceptedAt: "2026-07-31T00:03:00.000Z",
          }),
        ),
      ).rejects.toThrow("requires an active connection");

      const restored = await bindings.putGitHubProviderConnection(
        connectionInput({ observedAt: "2026-07-31T00:04:00.000Z" }),
      );
      expect(restored.status).toBe("active");
      expect(await bindings.getGitHubProviderConnection(restored.id)).toEqual(restored);
    } finally {
      store.close();
    }
  });

  test("rejects installation drift under a stable connection ID", () => {
    const store = storeWithProject();
    try {
      putSqliteGitHubProviderConnection(store, connectionInput());
      expect(() =>
        putSqliteGitHubProviderConnection(
          store,
          connectionInput({
            installationId: "43",
            observedAt: "2026-07-31T00:02:00.000Z",
          }),
        )
      ).toThrow("changed its installation or credential identity");
    } finally {
      store.close();
    }
  });

  test("rejects credential locator drift under a stable connection ID", () => {
    const store = storeWithProject();
    try {
      putSqliteGitHubProviderConnection(store, connectionInput());
      expect(() =>
        putSqliteGitHubProviderConnection(
          store,
          connectionInput({
            credentialRef: "secret://ANOTHER_GITHUB_APP_PRIVATE_KEY",
            observedAt: "2026-07-31T00:02:00.000Z",
          }),
        )
      ).toThrow("changed its installation or credential identity");
    } finally {
      store.close();
    }
  });

  test("reconciles provider account rename under one installation", () => {
    const store = storeWithProject();
    try {
      putSqliteGitHubProviderConnection(store, connectionInput());
      const renamed = putSqliteGitHubProviderConnection(
        store,
        connectionInput({
          accountLogin: "TeamLeaderLeoRenamed",
          repositoryFullNames: ["TeamLeaderLeoRenamed/Stensibly"],
          observedAt: "2026-07-31T00:02:00.000Z",
        }),
      );
      expect(renamed.accountLogin).toBe("teamleaderleorenamed");
      expect(renamed.credentialRef).toBe(
        "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
      );
      expect(renamed.repositoryFullNames).toEqual([
        "teamleaderleorenamed/stensibly",
      ]);
      expect(getSqliteGitHubProviderConnection(store, renamed.id)).toEqual(renamed);
    } finally {
      store.close();
    }
  });

  test("rejects a second connection identity for one GitHub App installation", () => {
    const store = storeWithProject();
    try {
      putSqliteGitHubProviderConnection(store, connectionInput());
      expect(() =>
        putSqliteGitHubProviderConnection(
          store,
          connectionInput({
            id: "github-connection:installation-42-alias",
            observedAt: "2026-07-31T00:02:00.000Z",
          }),
        )
      ).toThrow("already belongs to connection");
    } finally {
      store.close();
    }
  });

  test("records active, revoked, and reactivated binding transitions", async () => {
    const store = storeWithProject();
    try {
      const bindings = new SqliteGitHubProviderBindingStore(store);
      await bindings.putGitHubProviderConnection(connectionInput());
      const active = await bindings.putGitHubProjectRepositoryBinding(bindingInput());
      expect(active.status).toBe("active");

      await expect(
        bindings.putGitHubProjectRepositoryBinding(
          bindingInput({
            id: "github-binding:scrapbook:stensibly:parallel",
            acceptedAt: "2026-07-31T00:02:00.000Z",
          }),
        ),
      ).rejects.toBeInstanceOf(GitHubProviderBindingStoreConflictError);

      await expect(
        bindings.putGitHubProjectRepositoryBinding(
          bindingInput({
            id: "github-binding:scrapbook:stensibly:equal-time-revoke",
            status: "revoked",
          }),
        ),
      ).rejects.toThrow("must advance beyond");

      const revoked = await bindings.putGitHubProjectRepositoryBinding(
        bindingInput({
          id: "github-binding:scrapbook:stensibly:revoke-1",
          status: "revoked",
          acceptedAt: "2026-07-31T00:03:00.000Z",
        }),
      );
      expect(revoked.status).toBe("revoked");

      await expect(
        bindings.putGitHubProjectRepositoryBinding(
          bindingInput({
            id: "github-binding:scrapbook:stensibly:equal-time-reactivate",
            attachmentId: "attachment:scrapbook:2",
            attachmentSnapshotSha256: `sha256:${"b".repeat(64)}`,
            acceptedAt: "2026-07-31T00:03:00.000Z",
          }),
        ),
      ).rejects.toThrow("must advance beyond");

      const reactivated = await bindings.putGitHubProjectRepositoryBinding(
        bindingInput({
          id: "github-binding:scrapbook:stensibly:2",
          attachmentId: "attachment:scrapbook:2",
          attachmentSnapshotSha256: `sha256:${"b".repeat(64)}`,
          acceptedAt: "2026-07-31T00:04:00.000Z",
        }),
      );
      expect(reactivated.status).toBe("active");
      expect(
        await bindings.getGitHubProjectRepositoryBinding(
          "scrapbook",
          "teamleaderleo/stensibly",
        ),
      ).toEqual(reactivated);
    } finally {
      store.close();
    }
  });

  test("allows an exact binding tombstone after repository access is removed", () => {
    const store = storeWithProject();
    try {
      putSqliteGitHubProviderConnection(store, connectionInput());
      putSqliteGitHubProjectRepositoryBinding(store, bindingInput());
      putSqliteGitHubProviderConnection(
        store,
        connectionInput({
          repositoryFullNames: ["teamleaderleo/zensibly"],
          observedAt: "2026-07-31T00:02:00.000Z",
        }),
      );

      const revoked = putSqliteGitHubProjectRepositoryBinding(
        store,
        bindingInput({
          id: "github-binding:scrapbook:stensibly:access-removed",
          status: "revoked",
          acceptedAt: "2026-07-31T00:03:00.000Z",
        }),
      );
      expect(revoked.status).toBe("revoked");
    } finally {
      store.close();
    }
  });

  test("requires a revoked tombstone to close the exact current authority", () => {
    const store = storeWithProject();
    try {
      putSqliteGitHubProviderConnection(store, connectionInput());
      putSqliteGitHubProjectRepositoryBinding(store, bindingInput());

      expect(() =>
        putSqliteGitHubProjectRepositoryBinding(
          store,
          bindingInput({
            id: "github-binding:scrapbook:stensibly:bad-revoke",
            status: "revoked",
            attachmentId: "attachment:scrapbook:other",
            acceptedAt: "2026-07-31T00:02:00.000Z",
          }),
        )
      ).toThrow(GitHubProviderBindingStoreConflictError);

      expect(() =>
        putSqliteGitHubProjectRepositoryBinding(
          store,
          bindingInput({
            id: "github-binding:scrapbook:zensibly:revoke",
            repositoryFullName: "teamleaderleo/zensibly",
            status: "revoked",
            acceptedAt: "2026-07-31T00:02:00.000Z",
          }),
        )
      ).toThrow(GitHubProviderBindingStoreConflictError);
    } finally {
      store.close();
    }
  });

  test("rejects active bindings through inactive or out-of-scope connections", () => {
    const store = storeWithProject();
    try {
      putSqliteGitHubProviderConnection(
        store,
        connectionInput({ status: "suspended" }),
      );
      expect(() =>
        putSqliteGitHubProjectRepositoryBinding(
          store,
          bindingInput({ id: "github-binding:scrapbook:inactive" }),
        )
      ).toThrow("requires an active connection");

      putSqliteGitHubProviderConnection(
        store,
        connectionInput({
          id: "github-connection:installation-44",
          installationId: "44",
          repositoryFullNames: ["teamleaderleo/zensibly"],
        }),
      );
      expect(() =>
        putSqliteGitHubProjectRepositoryBinding(
          store,
          bindingInput({
            id: "github-binding:scrapbook:outside",
            connectionId: "github-connection:installation-44",
          }),
        )
      ).toThrow("outside the connection");
    } finally {
      store.close();
    }
  });

  test("re-admits stored JSON and rejects database metadata drift", () => {
    const store = storeWithProject();
    try {
      const connection = putSqliteGitHubProviderConnection(store, connectionInput());
      store.db.query(`
        UPDATE github_provider_connections
        SET record_json = ?1
        WHERE id = ?2
      `).run(
        JSON.stringify({
          ...connection,
          credentialRef: "raw-private-key-material",
        }),
        connection.id,
      );

      expect(() =>
        getSqliteGitHubProviderConnection(store, connection.id)
      ).toThrow("credential reference");
    } finally {
      store.close();
    }
  });
});
