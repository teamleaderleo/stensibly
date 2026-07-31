import { describe, expect, test } from "bun:test";

const [document, laneRegistry] = await Promise.all([
  Bun.file(
    new URL("../docs/frontend-inspiration-index.md", import.meta.url),
  ).text(),
  Bun.file(
    new URL("../docs/frontend-inspiration-lanes.md", import.meta.url),
  ).text(),
]);

const entries = document
  .split(/(?=^### INSP-\d{3} — )/mu)
  .filter((entry) => /^### INSP-\d{3} — /u.test(entry));

const requiredEvidenceClasses = [
  "award-catalogue",
  "product-doc",
  "product-changelog",
  "standard-or-study",
  "community-thread",
  "marketing-page",
] as const;

const requiredLanes = [
  ["Quiet Control", 620],
  ["Soft Companion", 608],
  ["Field Console", 610],
  ["Signal Atlas", 611],
  ["Studio Canvas", 612],
] as const;

const entryIds = entries.map((entry) => {
  const id = entry.match(/^### (INSP-\d{3}) — /u)?.[1];
  if (!id) throw new Error("Frontend inspiration entry is missing its exact ID");
  return id;
});
const entriesById = new Map(
  entryIds.map((id, index) => [id, entries[index]!] as const),
);
const registeredLaneLabels = new Set(
  [...laneRegistry.matchAll(
    /^\| ([^|]+?) \| \[#\d+\]\(https:\/\/github\.com\/teamleaderleo\/stensibly\/issues\/\d+\) \|/gmu,
  )].map((match) => match[1]!.trim()),
);
const routingRows = [...laneRegistry.matchAll(
  /^\| (INSP-\d{3}) \| ((?:`[^`]+`(?:; )?)+) \|$/gmu,
)].map((match) => ({
  entryId: match[1]!,
  lanes: [...match[2]!.matchAll(/`([^`]+)`/gu)].map((lane) => lane[1]!),
}));

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function entryField(entry: string, field: string): string | null {
  return entry.match(new RegExp(`^- ${field}: (.+)$`, "mu"))?.[1]?.trim() ?? null;
}

describe("frontend inspiration index", () => {
  test("keeps a diverse, uniquely identified research set", () => {
    expect(entries.length).toBeGreaterThanOrEqual(40);
    expect(new Set(entryIds).size).toBe(entryIds.length);

    for (const evidenceClass of requiredEvidenceClasses) {
      expect(document).toContain(`Evidence: \`${evidenceClass}\``);
    }
  });

  test("requires every entry to remain attributable and actionable", () => {
    for (const entry of entries) {
      for (const field of [
        "- Source:",
        "- Evidence:",
        "- Category:",
        "- Pattern:",
        "- Application:",
        "- Disposition:",
        "- Limit:",
      ]) {
        expect(entry).toContain(field);
      }

      expect(entry).toMatch(/- Source: \[[^\]]+\]\(https:\/\/[^)]+\)/u);
      expect(entry).toMatch(/- Disposition: `(adopt|adapt|test|reject)`/u);
      expect(entryField(entry, "Application")?.length ?? 0).toBeGreaterThan(10);
      expect(entryField(entry, "Limit")?.length ?? 0).toBeGreaterThan(20);

      const evidence = entry.match(
        /^- Evidence: `([^`]+)`; inspected (\d{4}-\d{2}-\d{2})\.$/mu,
      );
      expect(evidence).toBeDefined();
      expect(requiredEvidenceClasses).toContain(
        evidence?.[1] as (typeof requiredEvidenceClasses)[number],
      );
      expect(isIsoDate(evidence?.[2] ?? "")).toBe(true);
    }
  });

  test("routes every entry through exact bounded owner lanes", () => {
    expect(routingRows).toHaveLength(entries.length);
    expect(new Set(routingRows.map((row) => row.entryId)).size).toBe(
      routingRows.length,
    );
    expect(routingRows.map((row) => row.entryId).sort()).toEqual(
      [...entryIds].sort(),
    );

    for (const { lanes } of routingRows) {
      expect(lanes.length).toBeGreaterThanOrEqual(1);
      expect(lanes.length).toBeLessThanOrEqual(5);
      expect(new Set(lanes).size).toBe(lanes.length);
      for (const lane of lanes) {
        expect(registeredLaneLabels.has(lane)).toBe(true);
      }
    }
  });

  test("keeps lane risks, experiments, and update discipline explicit", () => {
    expect(document).toContain("## Changed recommendations in this synthesis");
    expect(document).toContain("## Lane reading lists and applied experiments");
    expect(document).toContain("## Update protocol");

    for (const [lane, issueNumber] of requiredLanes) {
      const laneSection = document.match(
        new RegExp(`### ${lane}\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`, "u"),
      )?.[1];
      expect(laneSection).toBeDefined();
      expect(laneSection).toContain("Read:");
      expect(laneSection).toContain("Experiments:");
      expect(laneSection?.match(/^\d+\./gmu)?.length ?? 0).toBeGreaterThanOrEqual(3);

      const laneEntries = routingRows
        .filter((row) => row.lanes.includes(lane))
        .map((row) => entriesById.get(row.entryId))
        .filter((entry): entry is string => Boolean(entry));
      expect(laneEntries.length).toBeGreaterThan(0);
      expect(laneEntries.some((entry) =>
        entryField(entry, "Disposition")?.startsWith("`reject`")
        || entryField(entry, "Category")?.toLowerCase().includes("anti-pattern")
      )).toBe(true);

      expect(laneRegistry).toContain(`| ${lane} |`);
      expect(laneRegistry).toContain(
        `https://github.com/teamleaderleo/stensibly/issues/${issueNumber}`,
      );
    }

    for (const issueNumber of [556, 605, 607, 616, 618]) {
      expect(laneRegistry).toContain(
        `https://github.com/teamleaderleo/stensibly/issues/${issueNumber}`,
      );
    }
    expect(laneRegistry).toContain("## Entry routing");
    expect(laneRegistry).toContain("## Link rule");
  });

  test("links or describes source work without copying imagery", () => {
    expect(document).not.toMatch(/!\[[^\]]*\]\([^)]+\)/u);
    expect(laneRegistry).not.toMatch(/!\[[^\]]*\]\([^)]+\)/u);
    expect(document).toContain(
      "it contains no copied award imagery or screenshots",
    );
  });
});
