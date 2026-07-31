import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(
  join(import.meta.dir, "..", "site", "labs", "quiet-control", "index.html"),
  "utf8",
);

describe("Quiet Control accessible region names", () => {
  test("names the command search independently of placeholder text", () => {
    expect(html).toContain(
      'id="command-input" type="search" aria-label="Search work, shared tasks, and commands"',
    );
    expect(html).toContain('aria-labelledby="command-title"');
  });

  test("names the selected-detail landmark before dynamic content renders", () => {
    expect(html).toContain(
      'id="detail-pane" tabindex="-1" aria-label="Selected work detail"',
    );
  });
});
