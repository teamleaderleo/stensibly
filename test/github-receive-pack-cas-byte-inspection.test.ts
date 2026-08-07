import { describe, expect, test } from "bun:test";
import {
  admitGitReceivePackAdvertisement,
  admitGitReceivePackCasReport,
} from "../src/github-receive-pack-cas.ts";

const targetRef = "feature/exact-cas";
const expectedHeadSha = "a".repeat(40);
const encoder = new TextEncoder();

describe("Git receive-pack byte input detachment", () => {
  test("does not consult typed-array constructor or species while copying", () => {
    let constructorReads = 0;
    const advertisement = hostileBytes(packets([
      "# service=git-receive-pack\n",
      null,
      `${expectedHeadSha} refs/heads/${targetRef}\0report-status\n`,
      null,
    ]), () => {
      constructorReads += 1;
    });
    const report = hostileBytes(packets([
      "unpack ok\n",
      `ok refs/heads/${targetRef}\n`,
      null,
    ]), () => {
      constructorReads += 1;
    });

    expect(admitGitReceivePackAdvertisement(
      advertisement,
      targetRef,
      expectedHeadSha,
    )).toMatchObject({ targetRef, targetHeadSha: expectedHeadSha });
    expect(() => admitGitReceivePackCasReport(report, targetRef)).not.toThrow();
    expect(constructorReads).toBe(0);
  });
});

function hostileBytes(
  source: Uint8Array,
  onConstructorRead: () => void,
): Uint8Array {
  class HostileBytes extends Uint8Array {}
  const value = new HostileBytes(source);
  Object.defineProperty(value, "constructor", {
    configurable: true,
    get() {
      onConstructorRead();
      throw new Error("typed-array constructor must not be inspected");
    },
  });
  return value;
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
  const size = chunks.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
