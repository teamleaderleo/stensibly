import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseDeliveryDeskProjection,
  renderDeliveryDeskMarkdown,
} from "../src/delivery-desk.ts";

const snapshot = JSON.parse(readFileSync(
  new URL("../docs/delivery-desk-current.json", import.meta.url),
  "utf8",
));

describe("current Delivery Desk snapshot", () => {
  test("is a canonical bounded projection over active finish-line work", () => {
    const projection = parseDeliveryDeskProjection(snapshot);
    expect(projection.entries.map((entry) => entry.issue.number)).toEqual([
      564,
      566,
      572,
      573,
      574,
      510,
    ]);
    expect(projection.entries.every((entry) =>
      entry.selectedState !== "land-now" || entry.carrier === null
    )).toBe(true);
    expect(projection.entries.filter((entry) => entry.carrier !== null).length).toBe(5);
    expect(projection.entries.at(-1)).toMatchObject({
      issue: { number: 510 },
      implementation: { pullRequestNumber: 580 },
      selectedState: "decision",
      disposition: "hold",
    });
  });

  test("renders canonical links, exact heads, gates, and the no-authority notice", () => {
    const markdown = renderDeliveryDeskMarkdown(snapshot);
    expect(markdown).toContain("teamleaderleo/stensibly#564");
    expect(markdown).toContain("[#567](https://github.com/teamleaderleo/stensibly/pull/567)");
    expect(markdown).toContain("`ae42271bdff1`");
    expect(markdown).toContain("run the current-main finalizer");
    expect(markdown).toContain("**decision**");
    expect(markdown).toContain("grants no merge, deployment, provider, credential");
  });
});
