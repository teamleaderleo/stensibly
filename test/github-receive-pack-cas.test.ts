import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  admitGitReceivePackAdvertisement,
  admitGitReceivePackCasReport,
  buildGitReceivePackCasRequest,
} from "../src/github-receive-pack-cas.ts";

const sha1Parent = "a".repeat(40);
const sha1Commit = "b".repeat(40);
const sha256Parent = "c".repeat(64);
const sha256Commit = "d".repeat(64);
const targetRef = "feature/exact-cas";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("Git receive-pack exact ref CAS protocol", () => {
  test("admits exact SHA-1 advertisement and minimizes retained capabilities", () => {
    const advertisement = receivePackAdvertisement({
      head: sha1Parent,
      capabilities: [
        "report-status",
        "delete-refs",
        "agent=git/2.50.1",
        "session-id=github.com:session/123",
      ],
    });
    expect(admitGitReceivePackAdvertisement(
      advertisement,
      targetRef,
      sha1Parent,
    )).toEqual({
      objectFormat: "sha1",
      capabilities: ["report-status"],
      targetRef,
      targetHeadSha: sha1Parent,
    });

    expect(() => admitGitReceivePackAdvertisement(
      advertisement,
      targetRef,
      "e".repeat(40),
    )).toThrow("Git receive-pack advertisement is invalid");
  });

  test("admits SHA-256 object-format negotiation", () => {
    const advertisement = receivePackAdvertisement({
      head: sha256Parent,
      capabilities: [
        "report-status",
        "object-format=sha256",
        "agent=git/2.50.1",
      ],
    });
    expect(admitGitReceivePackAdvertisement(
      advertisement,
      targetRef,
      sha256Parent,
    )).toEqual({
      objectFormat: "sha256",
      capabilities: ["report-status", "object-format=sha256"],
      targetRef,
      targetHeadSha: sha256Parent,
    });
  });

  test("builds SHA-1 update command with a valid empty pack", () => {
    const request = buildGitReceivePackCasRequest({
      objectFormat: "sha1",
      advertisedCapabilities: ["report-status", "delete-refs", "agent=git/2.50.1"],
      targetRef,
      expectedHeadSha: sha1Parent,
      newHeadSha: sha1Commit,
    });
    const { command, pack } = splitRequest(request);
    expect(command).toBe(
      `${sha1Parent} ${sha1Commit} refs/heads/${targetRef}\0report-status\n`,
    );
    expect(pack.byteLength).toBe(32);
    expect(decoder.decode(pack.subarray(0, 4))).toBe("PACK");
    expect(new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(4, false))
      .toBe(2);
    expect(new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(8, false))
      .toBe(0);
    expect(hex(pack.subarray(12))).toBe(
      createHash("sha1").update(pack.subarray(0, 12)).digest("hex"),
    );
  });

  test("builds SHA-256 update command with object-format and SHA-256 empty pack", () => {
    const request = buildGitReceivePackCasRequest({
      objectFormat: "sha256",
      advertisedCapabilities: [
        "report-status",
        "object-format=sha256",
        "agent=git/2.50.1",
      ],
      targetRef,
      expectedHeadSha: sha256Parent,
      newHeadSha: sha256Commit,
    });
    const { command, pack } = splitRequest(request);
    expect(command).toBe(
      `${sha256Parent} ${sha256Commit} refs/heads/${targetRef}\0report-status object-format=sha256\n`,
    );
    expect(pack.byteLength).toBe(44);
    expect(hex(pack.subarray(12))).toBe(
      createHash("sha256").update(pack.subarray(0, 12)).digest("hex"),
    );
  });

  test("rejects object-format mismatch and duplicate object-format capabilities", () => {
    expect(() => buildGitReceivePackCasRequest({
      objectFormat: "sha256",
      advertisedCapabilities: ["report-status", "object-format=sha256"],
      targetRef,
      expectedHeadSha: sha1Parent,
      newHeadSha: sha1Commit,
    })).toThrow("Git receive-pack CAS request is invalid");

    expect(() => buildGitReceivePackCasRequest({
      objectFormat: "sha256",
      advertisedCapabilities: ["report-status"],
      targetRef,
      expectedHeadSha: sha256Parent,
      newHeadSha: sha256Commit,
    })).toThrow("Git receive-pack CAS request is invalid");

    expect(() => admitGitReceivePackAdvertisement(
      receivePackAdvertisement({
        head: sha256Parent,
        capabilities: [
          "report-status",
          "object-format=sha1",
          "object-format=sha256",
        ],
      }),
      targetRef,
      sha256Parent,
    )).toThrow("Git receive-pack advertisement is invalid");
  });

  test("accepts only ordered exact successful report-status for the target ref", () => {
    const success = packets([
      "unpack ok\n",
      `ok refs/heads/${targetRef}\n`,
      null,
    ]);
    expect(() => admitGitReceivePackCasReport(success, targetRef)).not.toThrow();

    const reversed = packets([
      `ok refs/heads/${targetRef}\n`,
      "unpack ok\n",
      null,
    ]);
    expect(() => admitGitReceivePackCasReport(reversed, targetRef))
      .toThrow("Git receive-pack CAS report is invalid");

    const stale = packets([
      "unpack ok\n",
      `ng refs/heads/${targetRef} stale info\n`,
      null,
    ]);
    expect(() => admitGitReceivePackCasReport(stale, targetRef))
      .toThrow("Git receive-pack CAS report is invalid");

    const foreign = packets([
      "unpack ok\n",
      "ok refs/heads/other\n",
      null,
    ]);
    expect(() => admitGitReceivePackCasReport(foreign, targetRef))
      .toThrow("Git receive-pack CAS report is invalid");
  });

  test("rejects trailing advertisement/report packets after flush", () => {
    const trailingAdvertisement = packets([
      "# service=git-receive-pack\n",
      null,
      `${sha1Parent} refs/heads/${targetRef}\0report-status\n`,
      null,
      `${sha1Parent} refs/heads/ignored\n`,
    ]);
    expect(() => admitGitReceivePackAdvertisement(
      trailingAdvertisement,
      targetRef,
      sha1Parent,
    )).toThrow("Git receive-pack advertisement is invalid");

    const trailingReport = packets([
      "unpack ok\n",
      `ok refs/heads/${targetRef}\n`,
      null,
      "unpack ok\n",
    ]);
    expect(() => admitGitReceivePackCasReport(trailingReport, targetRef))
      .toThrow("Git receive-pack CAS report is invalid");
  });

  test("rejects missing report-status and malformed pkt-line framing", () => {
    expect(() => admitGitReceivePackAdvertisement(
      receivePackAdvertisement({ head: sha1Parent, capabilities: ["delete-refs"] }),
      targetRef,
      sha1Parent,
    )).toThrow("Git receive-pack advertisement is invalid");

    expect(() => admitGitReceivePackAdvertisement(
      encoder.encode("0003"),
      targetRef,
      sha1Parent,
    )).toThrow("Git receive-pack advertisement is invalid");
  });

  test("keeps malformed capability diagnostics scoped to advertisement admission", () => {
    const malformed = receivePackAdvertisement({
      head: sha1Parent,
      capabilities: ["report-status", "bad\tcapability"],
    });
    expect(() => admitGitReceivePackAdvertisement(malformed, targetRef, sha1Parent))
      .toThrow("Git receive-pack advertisement is invalid");
  });

  test("rejects oversized advertisement and report before packet iteration", () => {
    expect(() => admitGitReceivePackAdvertisement(
      new Uint8Array(64 * 1024 + 1),
      targetRef,
      sha1Parent,
    )).toThrow("Git receive-pack advertisement is invalid");
    expect(() => admitGitReceivePackCasReport(
      new Uint8Array(16 * 1024 + 1),
      targetRef,
    )).toThrow("Git receive-pack CAS report is invalid");
  });
});

function receivePackAdvertisement(input: {
  head: string;
  capabilities: readonly string[];
}): Uint8Array {
  return packets([
    "# service=git-receive-pack\n",
    null,
    `${input.head} refs/heads/${targetRef}\0${input.capabilities.join(" ")}\n`,
    null,
  ]);
}

function packets(values: readonly (string | null)[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const value of values) {
    if (value === null) {
      chunks.push(encoder.encode("0000"));
      continue;
    }
    const body = encoder.encode(value);
    chunks.push(encoder.encode((body.byteLength + 4).toString(16).padStart(4, "0")));
    chunks.push(body);
  }
  return concat(chunks);
}

function splitRequest(request: Uint8Array): { command: string; pack: Uint8Array } {
  const length = Number.parseInt(decoder.decode(request.subarray(0, 4)), 16);
  const command = decoder.decode(request.subarray(4, length));
  expect(decoder.decode(request.subarray(length, length + 4))).toBe("0000");
  return { command, pack: request.slice(length + 4) };
}

function concat(values: readonly Uint8Array[]): Uint8Array {
  const size = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}