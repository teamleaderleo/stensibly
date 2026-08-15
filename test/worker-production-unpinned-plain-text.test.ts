import { describe, expect, test } from "bun:test";
import {
  REQUIRED_PRODUCTION_BINDINGS,
  validateProductionVersion,
  type WorkerBinding,
} from "../scripts/worker-production-release.ts";

const presenceOnlyOutlookBindings = [
  "STENSIBLY_OUTLOOK_OAUTH_CLIENT_ID",
  "STENSIBLY_OUTLOOK_FOLDER_ID",
] as const;

function productionBindings(): WorkerBinding[] {
  return Object.entries(REQUIRED_PRODUCTION_BINDINGS).map(([name, expected]) => ({
    name,
    type: expected.type,
    ...(expected.text !== undefined ? { text: expected.text } : {}),
  }));
}

describe("production Worker presence-only plain-text bindings", () => {
  test("checks staged Outlook public identifiers by presence and type without pinning their values", () => {
    for (const name of presenceOnlyOutlookBindings) {
      expect(REQUIRED_PRODUCTION_BINDINGS[name]).toEqual({ name, type: "plain_text" });
    }

    const bindings = productionBindings().map((binding) => (
      presenceOnlyOutlookBindings.includes(binding.name as typeof presenceOnlyOutlookBindings[number])
        ? { ...binding, text: `operator-staged-${String(binding.name).toLowerCase()}` }
        : binding
    ));

    expect(validateProductionVersion({ resources: { bindings } })).toEqual([]);

    const wrongType = bindings.map((binding) => (
      binding.name === "STENSIBLY_OUTLOOK_FOLDER_ID"
        ? { ...binding, type: "secret_text" }
        : binding
    ));
    expect(validateProductionVersion({ resources: { bindings: wrongType } })).toContain(
      "binding STENSIBLY_OUTLOOK_FOLDER_ID has type secret_text; expected plain_text",
    );
  });
});
