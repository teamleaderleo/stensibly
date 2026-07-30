import { describe, expect, test } from "bun:test";
import {
  frontendLabManifest,
  frontendLabVariantById,
  parseFrontendLabManifest,
} from "../site/labs/manifest.js";

function cloneManifest() {
  return JSON.parse(JSON.stringify(frontendLabManifest));
}

describe("frontend labs manifest", () => {
  test("publishes bounded same-origin variant identities", () => {
    expect(frontendLabManifest.map((entry) => entry.id)).toEqual([
      "quiet-control",
      "soft-companion",
      "field-console",
      "signal-atlas",
      "studio-canvas",
    ]);
    for (const entry of frontendLabManifest) {
      expect(entry.path).toBe(`./${entry.id}/`);
      expect(entry.issue).toBeGreaterThan(0);
      expect(entry.support.length).toBeGreaterThan(0);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.support)).toBe(true);
      if (entry.status === "prototype") {
        expect(entry.revision).toMatch(/^[0-9a-f]{7,40}$/);
      } else {
        expect(entry.revision).toBeNull();
      }
    }
    expect(Object.isFrozen(frontendLabManifest)).toBe(true);
    expect(frontendLabVariantById(cloneManifest(), "quiet-control")?.issue).toBe(620);
    expect(frontendLabVariantById(cloneManifest(), "missing")).toBeNull();
  });

  test("rejects unknown fields instead of dropping them", () => {
    const manifest = cloneManifest();
    manifest[0].remoteFlag = "quiet-control";
    expect(() => parseFrontendLabManifest(manifest)).toThrow("exact manifest fields");
  });

  test("rejects external, traversing, and identity-mismatched routes", () => {
    for (const path of [
      "https://example.com/quiet-control/",
      "../quiet-control/",
      "./soft-companion/",
      "./quiet-control?mode=live",
    ]) {
      const manifest = cloneManifest();
      manifest[0].path = path;
      expect(() => parseFrontendLabManifest(manifest)).toThrow("same-origin id route");
    }
  });

  test("rejects duplicate ids and routes", () => {
    const duplicateId = cloneManifest();
    duplicateId[1].id = duplicateId[0].id;
    duplicateId[1].path = duplicateId[0].path;
    expect(() => parseFrontendLabManifest(duplicateId)).toThrow("Duplicate frontend labs id");

    const duplicatePath = cloneManifest();
    duplicatePath[1].path = duplicatePath[0].path;
    expect(() => parseFrontendLabManifest(duplicatePath)).toThrow("same-origin id route");
  });

  test("requires exact revisions only for published prototypes", () => {
    const missingPrototypeRevision = cloneManifest();
    missingPrototypeRevision[0].revision = null;
    expect(() => parseFrontendLabManifest(missingPrototypeRevision)).toThrow("requires an exact hexadecimal revision");

    const claimedPlannedRevision = cloneManifest();
    claimedPlannedRevision[1].revision = "abcdef0";
    expect(() => parseFrontendLabManifest(claimedPlannedRevision)).toThrow("must not claim a revision");
  });

  test("rejects malformed support and unsafe text", () => {
    const duplicateSupport = cloneManifest();
    duplicateSupport[0].support = ["wide", "wide"];
    expect(() => parseFrontendLabManifest(duplicateSupport)).toThrow("support values must be unique");

    const unknownSupport = cloneManifest();
    unknownSupport[0].support = ["holographic"];
    expect(() => parseFrontendLabManifest(unknownSupport)).toThrow("support value is unsupported");

    const unsafeTitle = cloneManifest();
    unsafeTitle[0].title = "Quiet\u202eControl";
    expect(() => parseFrontendLabManifest(unsafeTitle)).toThrow("safe characters");
  });
});
