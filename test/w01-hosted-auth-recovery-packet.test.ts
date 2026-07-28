import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const packet = readFileSync(
  new URL("../docs/w01-hosted-auth-phase1-packet.md", import.meta.url),
  "utf8",
);

describe("W01 hosted-auth recovery packet", () => {
  test("uses one protected service-secret variable without a second alias", () => {
    expect(packet).toContain(
      "`STENSIBLY_SERVICE_SECRET` is the protected source and runtime variable",
    );
    expect(packet).toContain('CONVEX_URL="$PRODUCTION_CONVEX_URL"');
    expect(packet).not.toContain("PROTECTED_SERVICE_SECRET");
    expect(packet).not.toContain('STENSIBLY_SERVICE_SECRET="$');
  });

  test("separates public Convex provenance from protected values", () => {
    expect(packet).toContain(
      "The exact validated URL may be retained in bounded evidence as deployment",
    );
    expect(packet).toContain(
      "production_convex_url: <exact reviewed origin | not_run>",
    );
    expect(packet).toContain("- service-secret value");
  });

  test("permits truthful not-run evidence for observation-only fields", () => {
    expect(packet).toContain(
      "configuration_names_before: <bounded names-only list | not_run>",
    );
    expect(packet).toContain(
      "bootstrap_project_scope: oauth-dogfood | not_run",
    );
    expect(packet).toContain(
      "sets every uninspected or mutation-only field to",
    );
  });
});
