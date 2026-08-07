import { createHash } from "node:crypto";
import {
  admitGitHubBranchRef,
  admitGitObjectId,
  sameGitObjectFormat,
} from "./github-repository-write-admission.js";

export type GitReceivePackObjectFormat = "sha1" | "sha256";

export interface GitReceivePackAdvertisement {
  objectFormat: GitReceivePackObjectFormat;
  capabilities: readonly string[];
  targetRef: string;
  targetHeadSha: string;
}

export interface BuildGitReceivePackCasRequestInput {
  objectFormat: GitReceivePackObjectFormat;
  advertisedCapabilities: readonly string[];
  targetRef: string;
  expectedHeadSha: string;
  newHeadSha: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const maximumAdvertisementBytes = 64 * 1024;
const maximumReportBytes = 16 * 1024;
const maximumPacketCount = 512;
const capabilityPattern = /^[\x21-\x7e]{1,128}$/u;

export function admitGitReceivePackAdvertisement(
  bytes: Uint8Array,
  targetRef: string,
  expectedHeadSha: string,
): GitReceivePackAdvertisement {
  if (bytes.byteLength > maximumAdvertisementBytes) {
    throw invalidAdvertisement();
  }
  const branch = admitGitHubBranchRef(targetRef);
  const expected = admitGitObjectId(expectedHeadSha);
  const packets = parsePacketLines(bytes, maximumPacketCount, invalidAdvertisement);
  if (packets.length < 4 || packets.at(-1) !== null) throw invalidAdvertisement();
  const servicePacket = packets[0];
  if (
    servicePacket === undefined
    || servicePacket === null
    || decodePacket(servicePacket, invalidAdvertisement) !== "# service=git-receive-pack\n"
  ) {
    throw invalidAdvertisement();
  }
  if (packets[1] !== null) throw invalidAdvertisement();

  let firstRef = true;
  let advertisedHead: string | null = null;
  let retainedCapabilities: readonly string[] | null = null;
  let objectFormat: GitReceivePackObjectFormat = "sha1";
  const fullTargetRef = `refs/heads/${branch}`;

  for (let index = 2; index < packets.length - 1; index += 1) {
    const packet = packets[index];
    if (packet === undefined || packet === null) throw invalidAdvertisement();
    const text = decodePacket(packet, invalidAdvertisement);
    if (!text.endsWith("\n")) throw invalidAdvertisement();
    const line = text.slice(0, -1);
    const nul = line.indexOf("\0");
    const refText = nul >= 0 ? line.slice(0, nul) : line;
    const capabilityText = nul >= 0 ? line.slice(nul + 1) : null;
    if (firstRef) {
      if (capabilityText === null) throw invalidAdvertisement();
      const advertisedCapabilities = admitCapabilities(
        capabilityText,
        invalidAdvertisement,
      );
      const objectFormatCapabilities = advertisedCapabilities.filter((entry) =>
        entry.startsWith("object-format=")
      );
      if (objectFormatCapabilities.length > 1) throw invalidAdvertisement();
      const advertisedFormat = objectFormatCapabilities[0];
      if (advertisedFormat !== undefined) {
        if (advertisedFormat === "object-format=sha1") objectFormat = "sha1";
        else if (advertisedFormat === "object-format=sha256") objectFormat = "sha256";
        else throw invalidAdvertisement();
      }
      if (!advertisedCapabilities.includes("report-status")) {
        throw invalidAdvertisement();
      }
      retainedCapabilities = Object.freeze([
        "report-status",
        ...(advertisedFormat === undefined ? [] : [advertisedFormat]),
      ]);
      firstRef = false;
    } else if (capabilityText !== null) {
      throw invalidAdvertisement();
    }

    const match = /^(\S+) (refs\/[^\s]+)$/u.exec(refText);
    if (!match) throw invalidAdvertisement();
    let oid: string;
    try {
      oid = admitGitObjectId(match[1]);
    } catch {
      throw invalidAdvertisement();
    }
    if (oid.length !== objectIdLength(objectFormat)) throw invalidAdvertisement();
    if (match[2] === fullTargetRef) {
      if (advertisedHead !== null) throw invalidAdvertisement();
      advertisedHead = oid;
    }
  }

  if (
    firstRef
    || retainedCapabilities === null
    || advertisedHead !== expected
    || expected.length !== objectIdLength(objectFormat)
  ) {
    throw invalidAdvertisement();
  }

  return Object.freeze({
    objectFormat,
    capabilities: retainedCapabilities,
    targetRef: branch,
    targetHeadSha: advertisedHead,
  });
}

export function buildGitReceivePackCasRequest(
  input: BuildGitReceivePackCasRequestInput,
): Uint8Array {
  const branch = admitGitHubBranchRef(input.targetRef);
  const expected = admitGitObjectId(input.expectedHeadSha);
  const next = admitGitObjectId(input.newHeadSha);
  if (
    !sameGitObjectFormat(expected, next)
    || expected.length !== objectIdLength(input.objectFormat)
  ) {
    throw invalidRequest();
  }
  const capabilities = admitCapabilityList(
    input.advertisedCapabilities,
    invalidRequest,
  );
  if (!capabilities.includes("report-status")) throw invalidRequest();
  const objectFormatCapabilities = capabilities.filter((entry) =>
    entry.startsWith("object-format=")
  );
  if (objectFormatCapabilities.length > 1) throw invalidRequest();
  const advertisedObjectFormat = objectFormatCapabilities[0];
  if (
    input.objectFormat === "sha256"
      ? advertisedObjectFormat !== "object-format=sha256"
      : advertisedObjectFormat !== undefined
        && advertisedObjectFormat !== "object-format=sha1"
  ) {
    throw invalidRequest();
  }

  const requestedCapabilities = ["report-status"];
  if (advertisedObjectFormat !== undefined) {
    requestedCapabilities.push(advertisedObjectFormat);
  }
  const command = `${expected} ${next} refs/heads/${branch}\0${requestedCapabilities.join(" ")}\n`;
  const commandPacket = encodePacket(command);
  const emptyPack = emptyPackfile(input.objectFormat);
  return concatBytes(commandPacket, encoder.encode("0000"), emptyPack);
}

export function admitGitReceivePackCasReport(
  bytes: Uint8Array,
  targetRef: string,
): void {
  if (bytes.byteLength > maximumReportBytes) throw invalidReport();
  const branch = admitGitHubBranchRef(targetRef);
  const fullTargetRef = `refs/heads/${branch}`;
  const packets = parsePacketLines(bytes, maximumPacketCount, invalidReport);
  if (packets.length < 3 || packets.at(-1) !== null) throw invalidReport();
  let unpackOk = false;
  let targetOk = false;
  for (let index = 0; index < packets.length - 1; index += 1) {
    const packet = packets[index];
    if (packet === undefined || packet === null) throw invalidReport();
    const line = decodePacket(packet, invalidReport);
    if (!line.endsWith("\n")) throw invalidReport();
    const text = line.slice(0, -1);
    if (text === "unpack ok") {
      if (unpackOk) throw invalidReport();
      unpackOk = true;
      continue;
    }
    if (text === `ok ${fullTargetRef}`) {
      if (targetOk) throw invalidReport();
      targetOk = true;
      continue;
    }
    throw invalidReport();
  }
  if (!unpackOk || !targetOk) throw invalidReport();
}

function emptyPackfile(objectFormat: GitReceivePackObjectFormat): Uint8Array {
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"), 0);
  new DataView(header.buffer).setUint32(4, 2, false);
  new DataView(header.buffer).setUint32(8, 0, false);
  const trailer = createHash(objectFormat).update(header).digest();
  return concatBytes(header, trailer);
}

function encodePacket(value: string): Uint8Array {
  const body = encoder.encode(value);
  const length = body.byteLength + 4;
  if (length > 0xffff) throw invalidRequest();
  const prefix = encoder.encode(length.toString(16).padStart(4, "0"));
  return concatBytes(prefix, body);
}

function parsePacketLines(
  bytes: Uint8Array,
  maximumPackets: number,
  failure: () => Error,
): readonly (Uint8Array | null)[] {
  const packets: Array<Uint8Array | null> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (packets.length >= maximumPackets || offset + 4 > bytes.byteLength) {
      throw failure();
    }
    const prefix = decodeAscii(bytes.subarray(offset, offset + 4), failure);
    if (!/^[0-9a-f]{4}$/u.test(prefix)) throw failure();
    const length = Number.parseInt(prefix, 16);
    offset += 4;
    if (length === 0) {
      packets.push(null);
      continue;
    }
    if (length < 4) throw failure();
    const bodyLength = length - 4;
    if (offset + bodyLength > bytes.byteLength) throw failure();
    packets.push(bytes.slice(offset, offset + bodyLength));
    offset += bodyLength;
  }
  return Object.freeze(packets);
}

function decodePacket(bytes: Uint8Array, failure: () => Error): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw failure();
  }
}

function decodeAscii(bytes: Uint8Array, failure: () => Error): string {
  for (const byte of bytes) {
    if (byte > 0x7f) throw failure();
  }
  return String.fromCharCode(...bytes);
}

function admitCapabilities(value: string, failure: () => Error): string[] {
  if (value.length === 0) return [];
  return admitCapabilityList(value.split(" "), failure);
}

function admitCapabilityList(
  value: readonly string[],
  failure: () => Error,
): string[] {
  if (!Array.isArray(value) || value.length > 128) throw failure();
  const result: string[] = [];
  const seen = new Set<string>();
  for (const capability of value) {
    if (
      typeof capability !== "string"
      || !capabilityPattern.test(capability)
      || seen.has(capability)
    ) {
      throw failure();
    }
    seen.add(capability);
    result.push(capability);
  }
  return result;
}

function objectIdLength(format: GitReceivePackObjectFormat): number {
  return format === "sha1" ? 40 : 64;
}

function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function invalidAdvertisement(): RangeError {
  return new RangeError("Git receive-pack advertisement is invalid");
}

function invalidRequest(): RangeError {
  return new RangeError("Git receive-pack CAS request is invalid");
}

function invalidReport(): RangeError {
  return new RangeError("Git receive-pack CAS report is invalid");
}
