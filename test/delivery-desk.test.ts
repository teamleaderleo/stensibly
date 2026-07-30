import { describe, expect, test } from "bun:test";
import {
  createDeliveryDeskProjection,
  currentFactsFromDeliveryDeskEntry,
  evaluateDeliveryDeskEntry,
  parseDeliveryDeskCurrentFacts,
  parseDeliveryDeskEntry,
  parseDeliveryDeskProjection,
  renderDeliveryDeskMarkdown,
  type DeliveryDeskEntry,
} from "../src/delivery-desk.ts";

const observedAt = "2026-07-31T00:00:00.000Z";

function hash(seed: number): string {
  return `sha256:${(seed % 16).toString(16).repeat(64)}`;
}

function commit(seed: number): string {
  return (seed % 16).toString(16).repeat(40);
}

function entry(
  issueNumber: number,
  overrides: Partial<DeliveryDeskEntry> = {},
): DeliveryDeskEntry {
  return {
    schemaVersion: 1,
    issue: {
      repository: "teamleaderleo/stensibly",
      number: issueNumber,
      url: `https://github.com/teamleaderleo/stensibly/issues/${issueNumber}`,
    },
    implementation: {
      repository: "teamleaderleo/stensibly",
      pullRequestNumber: issueNumber + 10,
      url: `https://github.com/teamleaderleo/stensibly/pull/${issueNumber + 10}`,
      branch: `juniper/${issueNumber}-delivery`,
      headSha: commit(issueNumber),
    },
    selectedState: "land-now",
    riskTier: "tier_1",
    evidence: [{
      kind: "review",
      reference: `review:${issueNumber}`,
      observedAt,
      fingerprint: hash(issueNumber),
    }],
    disposition: "accept",
    remainingGate: "revalidate exact head and merge the accepted candidate",
    owner: "actor:juniper",
    carrier: null,
    hostedState: "not_applicable",
    requiredInputFingerprint: hash(issueNumber + 1),
    reviewFingerprint: hash(issueNumber + 2),
    ...overrides,
  };
}

describe("Delivery Desk", () => {
  test("creates one canonical finish-line projection and renders no authority", () => {
    const decision = entry(571, {
      selectedState: "decision",
      disposition: "decision_required",
      evidence: [],
      reviewFingerprint: null,
      remainingGate: "choose whether the hosted projection is operator-only",
    });
    const polish = entry(570, {
      selectedState: "polish",
      disposition: "repair",
      evidence: [],
      reviewFingerprint: null,
      carrier: {
        kind: "workflow",
        reference: ".github/workflows/finalize.yml",
        headSha: commit(15),
        removable: true,
      },
      remainingGate: "run the source-only finalizer and retire its carrier",
    });
    const projection = createDeliveryDeskProjection({
      observedAt,
      entries: [decision, polish, entry(569)],
    });

    expect(projection.entries.map((item) => item.selectedState)).toEqual([
      "land-now",
      "polish",
      "decision",
    ]);
    expect(parseDeliveryDeskProjection(projection)).toEqual(projection);
    const markdown = renderDeliveryDeskMarkdown(projection);
    expect(markdown).toContain("# Delivery Desk");
    expect(markdown).toContain("**land-now**");
    expect(markdown).toContain("**polish**");
    expect(markdown).toContain("**decision**");
    expect(markdown).toContain("grants no merge, deployment, provider, credential");
    expect(markdown).toContain("Canonical issues and pull requests remain the source of truth");
  });

  test("invalidates landing status when any exact input moves", () => {
    const candidate = parseDeliveryDeskEntry(entry(571));
    const exactFacts = currentFactsFromDeliveryDeskEntry(candidate);
    expect(evaluateDeliveryDeskEntry(candidate, exactFacts)).toEqual({
      issueNumber: 571,
      selectedState: "land-now",
      effectiveState: "land-now",
      invalidations: [],
      landingEligible: true,
      authorizesIntegration: false,
      remainingGate: candidate.remainingGate,
    });

    const stale = evaluateDeliveryDeskEntry(candidate, {
      implementationHead: commit(14),
      requiredInputFingerprint: hash(14),
      reviewFingerprint: hash(15),
      evidenceFingerprints: [hash(13)],
      carrierHeadSha: commit(12),
    });
    expect(stale).toMatchObject({
      selectedState: "land-now",
      effectiveState: "polish",
      landingEligible: false,
      authorizesIntegration: false,
      invalidations: [
        "head_changed",
        "required_input_changed",
        "review_changed",
        "evidence_changed",
        "carrier_changed",
      ],
    });
  });

  test("keeps decision work distinct when its facts change", () => {
    const candidate = entry(580, {
      selectedState: "decision",
      disposition: "hold",
      evidence: [],
      reviewFingerprint: null,
      remainingGate: "resolve the policy conflict with the governing protocol",
    });
    const facts = currentFactsFromDeliveryDeskEntry(candidate);
    expect(evaluateDeliveryDeskEntry(candidate, {
      ...facts,
      implementationHead: commit(1),
    })).toMatchObject({
      effectiveState: "decision",
      invalidations: ["head_changed"],
      landingEligible: false,
    });
  });

  test("never permits carriers or unsupported dispositions to masquerade as landing work", () => {
    expect(() => parseDeliveryDeskEntry(entry(571, {
      carrier: {
        kind: "workflow",
        reference: ".github/workflows/finalize.yml",
        headSha: commit(2),
        removable: true,
      },
    }))).toThrow("land-now requires accepted evidence and no execution carrier");

    expect(() => parseDeliveryDeskEntry(entry(571, {
      selectedState: "final-gate",
      disposition: "pending",
      evidence: [],
      reviewFingerprint: null,
    }))).toThrow("final-gate requires executed evidence");

    expect(() => parseDeliveryDeskEntry(entry(571, {
      selectedState: "polish",
      disposition: "accept",
    }))).toThrow("polish requires a repair or pending disposition");

    expect(() => parseDeliveryDeskEntry(entry(571, {
      selectedState: "decision",
      disposition: "pending",
      evidence: [],
      reviewFingerprint: null,
    }))).toThrow("decision requires a hold or explicit decision disposition");
  });

  test("requires exact canonical identities, ordering, timestamps, and fingerprints", () => {
    const candidate = entry(571);
    expect(() => parseDeliveryDeskEntry({
      ...candidate,
      issue: { ...candidate.issue, url: "https://github.com/other/repo/issues/571" },
    })).toThrow("issue URL is not canonical");
    expect(() => parseDeliveryDeskEntry({
      ...candidate,
      implementation: { ...candidate.implementation, headSha: "ABC" },
    })).toThrow("lowercase 40-character commit SHA");
    expect(() => parseDeliveryDeskEntry({
      ...candidate,
      extra: true,
    })).toThrow("unknown field extra");
    expect(() => parseDeliveryDeskEntry({
      ...candidate,
      evidence: [{ ...candidate.evidence[0]!, observedAt: "July 31, 2026" }],
    })).toThrow("canonical UTC timestamp");

    const projection = createDeliveryDeskProjection({
      observedAt,
      entries: [entry(571), entry(572)],
    });
    expect(() => parseDeliveryDeskProjection({
      ...projection,
      entries: [...projection.entries].reverse(),
    })).toThrow("canonical finish-line order");
    expect(() => parseDeliveryDeskProjection({
      ...projection,
      projectionFingerprint: hash(15),
    })).toThrow("fingerprint does not match");
  });

  test("requires unique canonical issues, implementations, evidence, and current facts", () => {
    expect(() => createDeliveryDeskProjection({
      observedAt,
      entries: [entry(571), entry(571)],
    })).toThrow("canonical issues must be unique");

    const first = entry(571);
    const second = entry(572, {
      implementation: first.implementation,
    });
    expect(() => createDeliveryDeskProjection({
      observedAt,
      entries: [first, second],
    })).toThrow("implementations must be unique");

    expect(() => parseDeliveryDeskEntry({
      ...first,
      evidence: [first.evidence[0], first.evidence[0]],
    })).toThrow("evidence fingerprints must be unique");

    expect(() => parseDeliveryDeskCurrentFacts({
      ...currentFactsFromDeliveryDeskEntry(first),
      evidenceFingerprints: [hash(1), hash(1)],
    })).toThrow("current evidence fingerprints must be unique");
  });

  test("freezes accepted records and escapes table delimiters", () => {
    const candidate = parseDeliveryDeskEntry(entry(571, {
      remainingGate: "review exact head | merge only after CI",
    }));
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.evidence)).toBe(true);
    const projection = createDeliveryDeskProjection({ observedAt, entries: [candidate] });
    expect(renderDeliveryDeskMarkdown(projection)).toContain(
      "review exact head \\| merge only after CI",
    );
  });
});
