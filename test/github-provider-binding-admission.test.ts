import { describe, expect, test } from "bun:test";
import type { GitHubProviderConnection } from "../src/github-provider-contracts.ts";
import {
  admitGitHubProjectRepositoryBinding,
  admitGitHubProviderConnection,
  validateBindingConnection,
} from "../src/github-provider-binding-admission.ts";

const attachmentFingerprint = `sha256:${"a".repeat(64)}`;

function connectionInput() {
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
    observedAt: "2026-07-31T00:00:00Z",
  };
}

function bindingInput() {
  return {
    id: "github-binding:oauth-dogfood:stensibly",
    project: "oauth-dogfood",
    repositoryFullName: "TEAMLEADERLEO/STENSIBLY",
    connectionId: "github-connection:installation-42",
    attachmentId: "attachment:oauth-dogfood",
    attachmentSnapshotSha256: attachmentFingerprint,
    status: "active",
    acceptedAt: "2026-07-31T00:01:00Z",
  };
}

describe("GitHub provider binding admission", () => {
  test("canonicalizes and deeply freezes a persistence-ready connection", () => {
    const connection = admitGitHubProviderConnection(connectionInput());

    expect(connection).toEqual({
      id: "github-connection:installation-42",
      provider: "github",
      installationId: "42",
      accountLogin: "teamleaderleo",
      credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
      status: "active",
      repositoryFullNames: [
        "teamleaderleo/stensibly",
        "teamleaderleo/zensibly",
      ],
      observedAt: "2026-07-31T00:00:00.000Z",
    } satisfies GitHubProviderConnection);
    expect(Object.isFrozen(connection)).toBe(true);
    expect(Object.isFrozen(connection.repositoryFullNames)).toBe(true);
    expect(() => connection.repositoryFullNames.push("teamleaderleo/other")).toThrow();
  });

  test("admits an empty installation inventory as zero repository authority", () => {
    const connection = admitGitHubProviderConnection({
      ...connectionInput(),
      repositoryFullNames: [],
    });

    expect(connection.repositoryFullNames).toEqual([]);
    expect(Object.isFrozen(connection.repositoryFullNames)).toBe(true);
    expect(() => admitGitHubProjectRepositoryBinding(bindingInput(), connection)).toThrow(
      "repository is outside the connection",
    );
  });

  test("admits an exact binding only through its active repository connection", () => {
    const connection = admitGitHubProviderConnection(connectionInput());
    const binding = admitGitHubProjectRepositoryBinding(bindingInput(), connection);

    expect(binding.repositoryFullName).toBe("teamleaderleo/stensibly");
    expect(binding.acceptedAt).toBe("2026-07-31T00:01:00.000Z");
    expect(Object.isFrozen(binding)).toBe(true);
  });

  test("enforces the lowercase project slug contract locally", () => {
    const valid = admitGitHubProjectRepositoryBinding({
      ...bindingInput(),
      project: "oauth_dogfood-2",
    });
    expect(valid.project).toBe("oauth_dogfood-2");

    for (const project of ["oauthDogfood", "oauth@dogfood", "oauth:dogfood", "oauth[dogfood"]) {
      expect(() => admitGitHubProjectRepositoryBinding({
        ...bindingInput(),
        project,
      })).toThrow("Use a lowercase project slug");
    }
  });

  test("requires exact ASCII bytes for persisted authority identities", () => {
    expect(() => admitGitHubProjectRepositoryBinding({
      ...bindingInput(),
      project: "ｏauth-dogfood",
    })).toThrow("must use exact printable ASCII");
    expect(() => admitGitHubProjectRepositoryBinding({
      ...bindingInput(),
      project: " oauth-dogfood",
    })).toThrow("must not contain surrounding whitespace");
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      id: "github-connection：installation-42",
    })).toThrow("must use exact printable ASCII");
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      installationId: "４２",
    })).toThrow("must use exact printable ASCII");
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      accountLogin: "ＴeamLeaderLeo",
    })).toThrow("must use exact printable ASCII");
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      accountLogin: " TeamLeaderLeo",
    })).toThrow("must not contain surrounding whitespace");
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      repositoryFullNames: [" teamleaderleo/stensibly"],
    })).toThrow("must not contain surrounding whitespace");
    expect(() => admitGitHubProjectRepositoryBinding({
      ...bindingInput(),
      repositoryFullName: "https://ｇithub.com/teamleaderleo/stensibly",
    })).toThrow("must use exact printable ASCII");
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      observedAt: "２０２６-07-31T00:00:00Z",
    })).toThrow("must use exact printable ASCII");
    expect(() => admitGitHubProjectRepositoryBinding({
      ...bindingInput(),
      acceptedAt: " 2026-07-31T00:01:00Z",
    })).toThrow("must not contain surrounding whitespace");
    expect(() => admitGitHubProjectRepositoryBinding({
      ...bindingInput(),
      attachmentSnapshotSha256: `ｓha256:${"a".repeat(64)}`,
    })).toThrow("must use exact printable ASCII");
  });

  test("requires plain own-property records while accepting null prototypes", () => {
    const nullPrototype = Object.assign(Object.create(null), connectionInput());
    expect(admitGitHubProviderConnection(nullPrototype)).toEqual(
      admitGitHubProviderConnection(connectionInput()),
    );

    const inherited = Object.create(connectionInput());
    expect(() => admitGitHubProviderConnection(inherited)).toThrow(
      "must be a plain object",
    );
  });

  test("snapshots enumerable data properties without invoking accessors", () => {
    let credentialReads = 0;
    const accessor = connectionInput();
    Object.defineProperty(accessor, "credentialRef", {
      enumerable: true,
      get() {
        credentialReads += 1;
        return "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY";
      },
    });
    expect(() => admitGitHubProviderConnection(accessor)).toThrow(
      "field credentialRef must be an enumerable data property",
    );
    expect(credentialReads).toBe(0);

    const symbolic = connectionInput();
    Object.defineProperty(symbolic, Symbol("accessToken"), {
      value: "github_pat_secret",
    });
    expect(() => admitGitHubProviderConnection(symbolic)).toThrow(
      "contains a symbol field",
    );
  });

  test("rejects unknown fields and non-canonical credential references", () => {
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      accessToken: "github_pat_secret",
    })).toThrow("unknown field accessToken");

    for (const credentialRef of [
      "github_pat_secret",
      " env://STENSIBLY_GITHUB_APP_PRIVATE_KEY ",
      "env://ＦＯＯ",
    ]) {
      expect(() => admitGitHubProviderConnection({
        ...connectionInput(),
        credentialRef,
      })).toThrow("must use env:// or secret://");
    }
  });

  test("re-admits connections before trusting authority fields", () => {
    const unadmitted = {
      ...connectionInput(),
      accessToken: "github_pat_secret",
    } as unknown as GitHubProviderConnection;

    expect(() => admitGitHubProjectRepositoryBinding(
      bindingInput(),
      unadmitted,
    )).toThrow("unknown field accessToken");
    expect(() => validateBindingConnection(bindingInput(), unadmitted)).toThrow(
      "unknown field accessToken",
    );
  });

  test("rejects sparse, decorated, accessor, cross-owner, and duplicate inventories", () => {
    const sparse = new Array<string>(1);
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      repositoryFullNames: sparse,
    })).toThrow("repositories must be dense");

    const decorated = ["teamleaderleo/stensibly"];
    Object.defineProperty(decorated, "credentialRef", {
      enumerable: false,
      value: "secret://hidden",
    });
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      repositoryFullNames: decorated,
    })).toThrow("repositories contain unknown field credentialRef");

    const inheritedDecoration = ["teamleaderleo/stensibly"];
    const inheritedPrototype = Object.create(Array.prototype);
    Object.defineProperty(inheritedPrototype, "credentialRef", {
      value: "secret://hidden",
    });
    Object.setPrototypeOf(inheritedDecoration, inheritedPrototype);
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      repositoryFullNames: inheritedDecoration,
    })).toThrow("repositories must use the default array prototype");

    let repositoryReads = 0;
    const accessor = ["teamleaderleo/stensibly"];
    Object.defineProperty(accessor, 0, {
      enumerable: true,
      get() {
        repositoryReads += 1;
        return "teamleaderleo/stensibly";
      },
    });
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      repositoryFullNames: accessor,
    })).toThrow("repositories must contain enumerable data entries");
    expect(repositoryReads).toBe(0);

    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      repositoryFullNames: ["another-owner/stensibly"],
    })).toThrow("outside installation account teamleaderleo");

    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      repositoryFullNames: [
        "teamleaderleo/stensibly",
        "TeamLeaderLeo/Stensibly",
      ],
    })).toThrow("repositories must be unique");

    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      repositoryFullNames: [
        "teamleaderleo/stensibly",
        "https://github.com/TeamLeaderLeo/Stensibly.git",
      ],
    })).toThrow("repositories must be unique");
  });

  test("rejects revoked bindings and unavailable or mismatched connections", () => {
    const active = admitGitHubProviderConnection(connectionInput());
    const revokedBinding = {
      ...bindingInput(),
      status: "revoked",
    };
    expect(admitGitHubProjectRepositoryBinding(revokedBinding).status).toBe("revoked");
    expect(() => admitGitHubProjectRepositoryBinding(revokedBinding, active)).toThrow(
      "binding must be active",
    );
    expect(() => validateBindingConnection(revokedBinding, active)).toThrow(
      "binding must be active",
    );

    expect(() => admitGitHubProjectRepositoryBinding({
      ...bindingInput(),
      connectionId: "github-connection:other",
    }, active)).toThrow("connection ID does not match");

    const suspended = admitGitHubProviderConnection({
      ...connectionInput(),
      status: "suspended",
    });
    expect(() => admitGitHubProjectRepositoryBinding(bindingInput(), suspended)).toThrow(
      "requires an active connection",
    );

    const otherRepository = admitGitHubProviderConnection({
      ...connectionInput(),
      repositoryFullNames: ["teamleaderleo/zensibly"],
    });
    expect(() => admitGitHubProjectRepositoryBinding(bindingInput(), otherRepository)).toThrow(
      "repository is outside the connection",
    );
  });

  test("rejects malformed identities, timestamps, and attachment fingerprints", () => {
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      installationId: "0042",
    })).toThrow("must be numeric");
    expect(() => admitGitHubProviderConnection({
      ...connectionInput(),
      observedAt: "tomorrow",
    })).toThrow("must be an ISO UTC timestamp");
    expect(() => admitGitHubProjectRepositoryBinding({
      ...bindingInput(),
      attachmentSnapshotSha256: "sha256:short",
    })).toThrow("must be a SHA-256 fingerprint");
  });
});
