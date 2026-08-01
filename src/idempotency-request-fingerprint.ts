export interface CreateItemFingerprintInput {
  project: string;
  kind: string;
  title: string;
  summary: string | null;
  nextAction: string | null;
  priority: number;
  actorId: string | null;
}

export interface AttachArtifactFingerprintInput {
  itemId: string;
  actorId: string;
  kind: string;
  label: string;
  uri: string;
  mimeType: string | null;
  metadata: Record<string, unknown>;
}

export function createItemRequestFingerprint(
  input: CreateItemFingerprintInput,
): string {
  return fingerprintCanonicalRequest({
    version: 1,
    operation: "item.create",
    project: input.project,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    nextAction: input.nextAction,
    priority: input.priority,
    actorId: input.actorId,
  });
}

export function attachArtifactRequestFingerprint(
  input: AttachArtifactFingerprintInput,
): string {
  return fingerprintCanonicalRequest({
    version: 1,
    operation: "artifact.attach",
    itemId: input.itemId,
    actorId: input.actorId,
    kind: input.kind,
    label: input.label,
    uri: input.uri,
    mimeType: input.mimeType,
    metadata: input.metadata,
  });
}

export function fingerprintCanonicalRequest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJsonString(value))}`;
}

export function fingerprintExactText(value: string): string {
  return `sha256:${sha256Hex(value)}`;
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (
        h + bigSigma1 + choose + SHA256_CONSTANTS[index]! + words[index]!
      ) >>> 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (bigSigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function firstPrimes(count: number): number[] {
  const primes: number[] = [];
  for (let candidate = 2; primes.length < count; candidate += 1) {
    if (primes.every((prime) => candidate % prime !== 0 || prime * prime > candidate)) {
      primes.push(candidate);
    }
  }
  return primes;
}

function fractionalWord(value: number): number {
  return Math.floor((value - Math.floor(value)) * 0x1_0000_0000) >>> 0;
}

const SHA256_CONSTANTS = new Uint32Array(
  firstPrimes(64).map((prime) => fractionalWord(Math.cbrt(prime))),
);
