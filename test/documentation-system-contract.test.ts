import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text();
}

describe("documentation brief experiment", () => {
  test("identifies the active overlay without relabelling the base protocol", async () => {
    const agents = await read("AGENTS.md");

    expect(agents).toContain(
      "**Operating protocol:** `stensibly-agent-ops/0.4.0`",
    );
    expect(agents).toContain(
      "**Active instruction experiment:** `documentation-brief/1` — #666",
    );
    expect(agents).toContain("In simple words / purpose:");
    expect(agents).toContain(
      "Use separate `In simple words` and `Purpose` headings only when each adds distinct",
    );
  });

  test("keeps the pull-request opening compact and optional sections removable", async () => {
    const template = await read(".github/pull_request_template.md");

    expect(template).toContain("## In simple words / purpose");
    expect(template).toContain(
      "Delete this section for mechanical changes",
    );
    expect(template).not.toContain("- Fence:");
    expect(template).not.toContain("- Risk:");
    expect(template).not.toContain("- Recovery:");
  });

  test("uses issue-backed decision identities instead of sequential allocation", async () => {
    const guide = await read("docs/documentation-system.md");
    const decisions = await read("docs/decisions/README.md");
    const decisionTemplate = await read("docs/decisions/_template.md");

    expect(guide).toContain(
      "docs/decisions/<issue-number>-<short-lowercase-slug>.md",
    );
    expect(guide).toContain("`docs/decisions/_template.md`");
    expect(guide).not.toContain("0000-template.md");
    expect(decisions).toContain("Do not create “the next ADR number.”");
    expect(decisionTemplate).toContain("- **Owning issue:** #NNNN");
  });
});
