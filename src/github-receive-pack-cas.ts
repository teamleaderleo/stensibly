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
const maximumCapabilities = 128;
const capabilityPattern = /^[\x21-\x7e]{1,128}$/u;

export function admitGitReceivePackAdvertisement(
  bytes: Uint8Array,
  targetRef: string,
  expectedHeadSha: string,
): GitReceivePackAdvertisement {
  const detachedBytes = detachedUint8Array(
    bytes,
    maximumAdvertisementBytes,
    invalidAdvertisement,
  );
  const branch = admitGitHubBranchRef(targetRef);
  const expected = admitGitObjectId(expectedHeadSha);
  const packets = parsePacketLines(
    detachedBytes,
    maximumPacketCount,
    invalidAdvertisement,
  );
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
  const snapshot = snapshotRequest(input);
  const branch = admitGitHubBranchRef(snapshot.targetRef);
  const expected = admitGitObjectId(snapshot.expectedHeadSha);
  const next = admitGitObjectId(snapshot.newHeadSha);
  if (
    !sameGitObjectFormat(expected, next)
    || expected.length !== objectIdLength(snapshot.objectFormat)
  ) {
    throw invalidRequest();
  }
  const capabilities = snapshot.advertisedCapabilities;
  if (!capabilities.includes("report-status")) throw invalidRequest();
  const objectFormatCapabilities = capabilities.filter((entry) =>
    entry.startsWith("object-format=")
  );
  if (objectFormatCapabilities.length > 1) throw invalidRequest();
  const advertisedObjectFormat = objectFormatCapabilities[0];
  if (
    snapshot.objectFormat === "sha256"
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
  const emptyPack = emptyPackfile(snapshot.objectFormat);
  return concatBytes(commandPacket, encoder.encode("0000"), emptyPack);
}

export function admitGitReceivePackCasReport(
  bytes: Uint8Array,
  targetRef: string,
): void {
  const detachedBytes = detachedUint8Array(bytes, maximumReportBytes, invalidReport);
  const branch = admitGitHubBranchRef(targetRef);
  const fullTargetRef = `refs/heads/${branch}`;
  const packets = parsePacketLines(detachedBytes, maximumPacketCount, invalidReport);
  if (packets.length !== 3 || packets[2] !== null) throw invalidReport();
  const unpackPacket = packets[0];
  const targetPacket = packets[1];
  if (
    unpackPacket === undefined
    || unpackPacket === null
    || targetPacket === undefined
    || targetPacket === null
  ) {
    throw invalidReport();
  }
  if (decodePacket(unpackPacket, invalidReport) !== "unpack ok\n") {
    throw invalidReport();
  }
  if (decodePacket(targetPacket, invalidReport) !== `ok ${fullTargetRef}\n`) {
    throw invalidReport();
  }
}

function snapshotRequest(value: unknown): BuildGitReceivePackCasRequestInput {
  if (!value || typeof value !== "object") {
    throw invalidRequest();
  }
  try {
    if (Array.isArray(value)) throw invalidRequest();
  } catch (error) {
    if (isInvalidRequest(error)) throw error;
    throw invalidRequest();
  }
  const objectFormat = requestStringProperty(value, "objectFormat");
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw invalidRequest();
  }
  const advertisedCapabilities = admitCapabilityList(
    requestDataProperty(value, "advertisedCapabilities"),
    invalidRequest,
  );
  return {
    objectFormat,
    advertisedCapabilities,
    targetRef: requestStringProperty(value, "targetRef"),
    expectedHeadSha: requestStringProperty(value, "expectedHeadSha"),
    newHeadSha: requestStringProperty(value, "newHeadSha"),
  };
}

function requestStringProperty(value: object, key: string): string {
  const candidate = requestDataProperty(value, key);
  if (typeof candidate !== "string") throw invalidRequest();
  return candidate;
}

function requestDataProperty(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw invalidRequest();
  }
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    throw invalidRequest();
  }
  return descriptor.value;
}

function detachedUint8Array(
  value: unknown,
  maximumBytes: number,
  failure: () => Error,
): Uint8Array {
  const bytes: number[] = [];
  const tooLarge = Symbol("receive-pack-too-large");
  try {
    Uint8Array.prototype.forEach.call(
      value as Uint8Array,
      (byte: number) => {
        if (bytes.length >= maximumBytes) throw tooLarge;
        bytes.push(byte);
      },
    );
  } catch (error) {
    if (error === tooLarge) throw failure();
    throw failure();
  }
  return new Uint8Array(bytes);
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
  value: unknown,
  failure: () => Error,
): string[] {
  if (!value || typeof value !== "object") throw failure();
  let isArray: boolean;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw failure();
  }
  if (
    !isArray
    || !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumCapabilities
  ) {
    throw failure();
  }
  const length = lengthDescriptor.value as number;
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      throw failure();
    }
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw failure();
    }
    const capability = descriptor.value;
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

function isInvalidRequest(error: unknown): error is RangeError {
  return error instanceof RangeError
    && error.message === "Git receive-pack CAS request is invalid";
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
