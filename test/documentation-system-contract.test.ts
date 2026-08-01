import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text();
}

describe("documentation brief experiment", () => {
  test("identifies the active overlay without relabelling the base protocol", async () => {
    const agents = await read("AGENTS.md");

    expect(agents).toContain(
      "**Operating protocol:** `stensibly-agent-ops/0.5.0`",
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

  test("puts genuine operator-only actions before the normal brief", async () => {
    const template = await read(".github/pull_request_template.md");
    const guide = await read("docs/operator-action-required.md");
    const contributing = await read("CONTRIBUTING.md");
    const policy = await read("STENSIBLY.md");

    expect(template).toContain("## Operator action required");
    expect(template.indexOf("## Operator action required")).toBeLessThan(
      template.indexOf("## In simple words / purpose"),
    );
    for (const field of [
      "**Action:**",
      "**Where:**",
      "**Minimum scope:**",
      "**Why now:**",
      "**Clears when:**",
      "**Secret handling:**",
    ]) {
      expect(template).toContain(field);
      expect(guide).toContain(field);
    }
    expect(guide).toContain(
      "Never ask the operator to paste a secret value",
    );
    expect(guide).toContain("Do not use the banner for routine work agents can complete");
    expect(contributing).toContain("docs/operator-action-required.md");
    expect(contributing).toContain("never ask anyone to paste a secret value");
    expect(policy).toContain("## Operator-only prerequisites");
    expect(policy).toContain("docs/operator-action-required.md");
    expect(policy).toContain("Never ask the operator to paste a token");
    expect(policy).toContain("Do not use this banner for work agents can complete");
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

  test("publishes one handbook and current-main code atlas under issue 693", async () => {
    const readme = await read("README.md");
    const contributing = await read("CONTRIBUTING.md");
    const handbook = await read("docs/engineering-handbook.md");
    const atlas = await read("docs/code-atlas.md");
    const decision = await read("docs/decisions/693-engineering-handbook.md");

    expect(readme).toContain("docs/engineering-handbook.md");
    expect(readme).toContain("docs/code-atlas.md");
    expect(contributing).toContain("docs/engineering-handbook.md");
    expect(contributing).toContain("docs/code-atlas.md");

    expect(handbook).toContain("- **Required invariant**");
    expect(handbook).toContain("- **Repository convention**");
    expect(handbook).toContain("- **Active experiment**");
    expect(handbook).toContain("## Ten recurring pitfalls");
    expect((handbook.match(/^\| [^\n]+ \| [^\n]+ \| [^\n]+ \|$/gm) ?? []).length)
      .toBeGreaterThanOrEqual(11);

    const headings = [
      "## 1. Strict GitHub provider binding admission",
      "## 2. Invocation-time runner authority",
      "## 3. Append-only SQLite provider binding history",
      "## 4. Guarded delegated GitHub read boundary",
      "## 5. Exact GitHub App installation permission profiles",
      "## 6. Literal CI queue receipts with zero mutation authority",
    ];
    for (const heading of headings) {
      expect(atlas).toContain(heading);
    }
    expect((atlas.match(/^## \d+\. /gm) ?? []).length).toBe(6);
    expect(atlas).toContain(
      "**Source pin for this edition:** `3cb781b530550ae0274b5c1f166ec289918eabce`",
    );
    expect(decision).toContain("- **Status:** experimenting");
    expect(decision).toContain("- **Owning issue:** #693");
  });
});
