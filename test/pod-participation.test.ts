import { describe, expect, test } from "bun:test";
import {
  buildPodParticipationRequest,
  type PodParticipationMode,
  type PodParticipationRequestInput,
} from "../src/pod-participation.ts";

const enrolmentFingerprint = `sha256:${"a".repeat(64)}`;

function request(
  overrides: Partial<PodParticipationRequestInput> = {},
): PodParticipationRequestInput {
  return {
    workerEnrolmentFingerprint: enrolmentFingerprint,
    workerRunId: "run_chat_20260727_teacup",
    participations: [
      {
        pod: "Relay",
        mode: "liaison",
        interests: ["Coordination"],
      },
      {
        pod: "Foundry",
        mode: "participant",
        interests: ["Review", "OAuth"],
        capabilities: ["TypeScript", "GitHub.Read"],
        acceptedCommitmentIds: ["commit_B", "commit_A"],
      },
    ],
    startedAt: "2026-07-27T13:30:00Z",
    expiresAt: "2026-07-27T17:30:00.000Z",
    correlationId: "corr_ABC",
    ...overrides,
  };
}

describe("pod participation request", () => {
  test("canonicalises a multi-pod request with a fixed fingerprint", () => {
    const built = buildPodParticipationRequest(request());

    expect(built).toEqual({
      version: 1,
      workerEnrolmentFingerprint: enrolmentFingerprint,
      workerRunId: "run_chat_20260727_teacup",
      participations: [
        {
          pod: "foundry",
          mode: "participant",
          interests: ["oauth", "review"],
          capabilities: ["github.read", "typescript"],
          acceptedCommitmentIds: ["commit_A", "commit_B"],
        },
        {
          pod: "relay",
          mode: "liaison",
          interests: ["coordination"],
          capabilities: [],
          acceptedCommitmentIds: [],
        },
      ],
      startedAt: "2026-07-27T13:30:00.000Z",
      expiresAt: "2026-07-27T17:30:00.000Z",
      correlationId: "corr_ABC",
      causationId: null,
      acceptsCommitments: true,
      participationActive: false,
      requiresDurableAcceptance: true,
      grantsMembership: false,
      grantsAuthority: false,
      fingerprint: "sha256:b1a42a6228b012a21a29e417bdbbfdb7d08fe906abe94b187457a596a4043f5a",
    });
  });

  test("replays exactly regardless of set-like input order", () => {
    const first = buildPodParticipationRequest(request());
    const second = buildPodParticipationRequest(request({
      participations: [
        {
          pod: "foundry",
          mode: "participant",
          interests: ["oauth", "review"],
          capabilities: ["github.read", "typescript"],
          acceptedCommitmentIds: ["commit_A", "commit_B"],
        },
        {
          pod: "relay",
          mode: "liaison",
          interests: ["coordination"],
        },
      ],
    }));
    expect(second).toEqual(first);
  });

  test("keeps a minimal observer request explicitly inactive and non-authoritative", () => {
    const built = buildPodParticipationRequest(request({
      participations: [{ pod: "Foundry", mode: "observer" }],
      correlationId: undefined,
      causationId: "cause_7",
    }));

    expect(built).toMatchObject({
      participations: [{
        pod: "foundry",
        mode: "observer",
        interests: [],
        capabilities: [],
        acceptedCommitmentIds: [],
      }],
      correlationId: null,
      causationId: "cause_7",
      acceptsCommitments: false,
      participationActive: false,
      requiresDurableAcceptance: true,
      grantsMembership: false,
      grantsAuthority: false,
    });
  });

  test("changes the fingerprint when material intent changes", () => {
    const participant = buildPodParticipationRequest(request({
      participations: [{ pod: "foundry", mode: "participant" }],
    }));
    const liaison = buildPodParticipationRequest(request({
      participations: [{ pod: "foundry", mode: "liaison" }],
    }));
    const commitment = buildPodParticipationRequest(request({
      participations: [{
        pod: "foundry",
        mode: "participant",
        acceptedCommitmentIds: ["commit_7"],
      }],
    }));

    expect(liaison.fingerprint).not.toBe(participant.fingerprint);
    expect(commitment.fingerprint).not.toBe(participant.fingerprint);
  });

  test("rejects duplicate pods and conflicting modes", () => {
    expect(() => buildPodParticipationRequest(request({
      participations: [
        { pod: "foundry", mode: "participant" },
        { pod: "Foundry", mode: "participant" },
      ],
    }))).toThrow("duplicate pod foundry");

    expect(() => buildPodParticipationRequest(request({
      participations: [
        { pod: "foundry", mode: "participant" },
        { pod: "Foundry", mode: "liaison" },
      ],
    }))).toThrow("conflicting modes for pod foundry");
  });

  test("rejects ambiguous commitment acceptance", () => {
    expect(() => buildPodParticipationRequest(request({
      participations: [{
        pod: "foundry",
        mode: "observer",
        acceptedCommitmentIds: ["commit_1"],
      }],
    }))).toThrow("Observer participation cannot accept commitments");

    expect(() => buildPodParticipationRequest(request({
      participations: [
        {
          pod: "foundry",
          mode: "participant",
          acceptedCommitmentIds: ["commit_1"],
        },
        {
          pod: "relay",
          mode: "liaison",
          acceptedCommitmentIds: ["commit_1"],
        },
      ],
    }))).toThrow("appears in more than one pod participation");
  });

  test("rejects malformed identities, modes, timestamps, and unsafe text", () => {
    expect(() => buildPodParticipationRequest(request({
      workerEnrolmentFingerprint: "sha256:nope",
    }))).toThrow("64 lowercase hexadecimal");
    expect(() => buildPodParticipationRequest(request({
      workerRunId: "chat_7",
    }))).toThrow("must start with run_");
    expect(() => buildPodParticipationRequest(request({
      participations: [{ pod: "Bad Pod", mode: "participant" }],
    }))).toThrow("lowercase pod slug");
    expect(() => buildPodParticipationRequest(request({
      participations: [{
        pod: "foundry",
        mode: "captain" as PodParticipationMode,
      }],
    }))).toThrow("Unknown pod participation mode");
    expect(() => buildPodParticipationRequest(request({
      startedAt: "2026-02-30T10:00:00Z",
    }))).toThrow("valid calendar timestamp");
    expect(() => buildPodParticipationRequest(request({
      expiresAt: "2026-07-27T13:29:59Z",
    }))).toThrow("later than start");
    expect(() => buildPodParticipationRequest(request({
      participations: [{
        pod: "foundry",
        mode: "participant",
        interests: ["safe", "\u202eunsafe"],
      }],
    }))).toThrow("control characters");
  });

  test("enforces list bounds and duplicate set entries", () => {
    expect(() => buildPodParticipationRequest(request({
      participations: [],
    }))).toThrow("1 to 16 entries");
    expect(() => buildPodParticipationRequest(request({
      participations: Array.from({ length: 17 }, (_, index) => ({
        pod: `pod_${index}`,
        mode: "participant" as const,
      })),
    }))).toThrow("1 to 16 entries");
    expect(() => buildPodParticipationRequest(request({
      participations: [{
        pod: "foundry",
        mode: "participant",
        capabilities: ["review", "Review"],
      }],
    }))).toThrow("duplicate entries");
    expect(() => buildPodParticipationRequest(request({
      participations: [{
        pod: "foundry",
        mode: "participant",
        acceptedCommitmentIds: ["commit_1", "commit_1"],
      }],
    }))).toThrow("duplicate entries");
  });
});
