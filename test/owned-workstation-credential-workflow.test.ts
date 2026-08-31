import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const workflow = readFileSync(fileURLToPath(new URL(
  "../.github/workflows/provision-owned-workstation-runner.yml",
  import.meta.url,
)), "utf8");

describe("owned workstation credential delivery workflow", () => {
  test("mints the same narrow runner grant for either node and exactly one project", () => {
    expect(workflow).toContain("- big-red\n          - air-blue");
    expect(workflow).toContain("- glaeda\n          - stensibly");
    expect(workflow).toContain('--actor-id "service:${RECIPIENT_NODE}-glaeda"');
    expect(workflow).toContain('--project "$PROJECT"');
    expect(workflow).toContain("--runner-type glaeda-workstation");
    expect(workflow).toContain("--adapter-id glaeda-workstation");
    expect(workflow).toContain("--profiles repo-query/v1,verify-focused/v1");
  });

  test("keeps ephemeral control separate and bound to the selected project", () => {
    expect(workflow).toContain("- ephemeral_control");
    expect(workflow).toContain("--scopes read,write");
    expect(workflow).toContain('--projects "$PROJECT"');
    expect(workflow).toContain('{purpose: "ephemeral_control"}');
  });

  test("publishes only node-sealed ciphertext and non-secret control metadata", () => {
    expect(workflow).toContain("runner-token.oaep-sha256.bin");
    expect(workflow).toContain("recipient-public-key.sha256");
    expect(workflow).toContain("metadata.json");
    expect(workflow).toContain('shred --remove "$credential_root/credential.token"');
    expect(workflow).not.toContain("credential.token\n          if-no-files-found");
  });
});
