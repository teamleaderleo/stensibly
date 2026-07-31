const allowedKeys = [
  "id",
  "issue",
  "owner",
  "path",
  "revision",
  "status",
  "support",
  "thesis",
  "title",
];

const statuses = new Set(["planned", "prototype"]);
const supportValues = new Set([
  "wide",
  "medium",
  "narrow",
  "light",
  "dark",
  "keyboard",
  "reduced-motion",
  "loading",
  "empty",
  "degraded",
  "error",
]);
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const revisionPattern = /^[0-9a-f]{7,40}$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

const sourceManifest = [
  {
    id: "quiet-control",
    title: "Quiet Control",
    thesis: "A restrained operator console with ranked attention, persistent evidence, and calm visual hierarchy.",
    owner: "Cinder",
    status: "prototype",
    revision: "a50d2045084eae6f13a794e2fc583e3af2da8ee0",
    issue: 620,
    path: "./quiet-control/",
    support: ["wide", "medium", "narrow", "light", "dark", "keyboard", "reduced-motion", "empty", "degraded"],
  },
  {
    id: "soft-companion",
    title: "Soft Companion",
    thesis: "A warm pastel productivity desk with tactile controls, gentle feedback, and an original companion character.",
    owner: "Cinder",
    status: "prototype",
    revision: "b29bc7f1655e8b30d3dc7d4041108e4b1aa7f0cd",
    issue: 608,
    path: "./soft-companion/",
    support: ["wide", "medium", "narrow", "light", "dark", "keyboard", "reduced-motion", "loading", "empty", "degraded", "error"],
  },
  {
    id: "field-console",
    title: "Field Console",
    thesis: "A dense operational view pairing exact object state, alert triage, topology, timeline, and detail.",
    owner: "Cinder",
    status: "prototype",
    revision: "8f9e13f7da46f3951284f2d920fdc99855259661",
    issue: 610,
    path: "./field-console/",
    support: ["wide", "medium", "narrow", "dark", "keyboard", "reduced-motion", "empty", "degraded", "error"],
  },
  {
    id: "signal-atlas",
    title: "Signal Atlas",
    thesis: "An editorial map and timeline treatment for explaining incidents, dependencies, and evidence as a guided narrative.",
    owner: "Cinder",
    status: "prototype",
    revision: "a4296f97402c76b02ed797177efc398814244e76",
    issue: 611,
    path: "./signal-atlas/",
    support: ["wide", "medium", "narrow", "light", "dark", "keyboard", "reduced-motion"],
  },
  {
    id: "studio-canvas",
    title: "Studio Canvas",
    thesis: "An artifact-first workspace with work navigation, versions, evidence, comments, and commands around the selected output.",
    owner: "unclaimed",
    status: "planned",
    revision: null,
    issue: 612,
    path: "./studio-canvas/",
    support: ["wide", "medium", "narrow", "light", "dark", "keyboard", "reduced-motion"],
  },
];

export const frontendLabManifest = parseFrontendLabManifest(sourceManifest);

export function parseFrontendLabManifest(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new TypeError("Frontend labs manifest must contain 1-20 variants");
  }

  const ids = new Set();
  const paths = new Set();
  const variants = value.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      throw new TypeError(`Frontend labs entry ${index + 1} must be an object`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== allowedKeys.join(",")) {
      throw new TypeError(`Frontend labs entry ${index + 1} must use the exact manifest fields`);
    }

    const id = boundedText(entry.id, 48, `Entry ${index + 1} id`);
    if (!idPattern.test(id)) throw new TypeError(`Entry ${index + 1} id must be a lowercase slug`);
    const path = boundedText(entry.path, 64, `Entry ${index + 1} path`);
    if (path !== `./${id}/`) throw new TypeError(`Entry ${index + 1} path must match its same-origin id route`);
    if (ids.has(id)) throw new TypeError(`Duplicate frontend labs id: ${id}`);
    if (paths.has(path)) throw new TypeError(`Duplicate frontend labs path: ${path}`);
    ids.add(id);
    paths.add(path);

    const status = boundedText(entry.status, 16, `Entry ${index + 1} status`);
    if (!statuses.has(status)) throw new TypeError(`Entry ${index + 1} status is unsupported`);
    const revision = entry.revision;
    if (status === "prototype") {
      if (typeof revision !== "string" || !revisionPattern.test(revision)) {
        throw new TypeError(`Prototype ${id} requires an exact hexadecimal revision`);
      }
    } else if (revision !== null) {
      throw new TypeError(`Planned variant ${id} must not claim a revision`);
    }

    const issue = entry.issue;
    if (!Number.isSafeInteger(issue) || issue < 1) {
      throw new TypeError(`Entry ${index + 1} issue must be a positive integer`);
    }

    if (!Array.isArray(entry.support) || entry.support.length < 1 || entry.support.length > 12) {
      throw new TypeError(`Entry ${index + 1} support must contain 1-12 values`);
    }
    const support = entry.support.map((item) => boundedText(item, 24, `Entry ${index + 1} support`));
    if (new Set(support).size !== support.length) {
      throw new TypeError(`Entry ${index + 1} support values must be unique`);
    }
    for (const item of support) {
      if (!supportValues.has(item)) throw new TypeError(`Entry ${index + 1} support value is unsupported`);
    }

    return Object.freeze({
      id,
      title: boundedText(entry.title, 80, `Entry ${index + 1} title`),
      thesis: boundedText(entry.thesis, 320, `Entry ${index + 1} thesis`),
      owner: boundedText(entry.owner, 80, `Entry ${index + 1} owner`),
      status,
      revision,
      issue,
      path,
      support: Object.freeze([...support]),
    });
  });

  return Object.freeze(variants);
}

export function frontendLabVariantById(manifest, id) {
  const parsed = parseFrontendLabManifest(manifest);
  const normalized = boundedText(id, 48, "Frontend labs id");
  return parsed.find((entry) => entry.id === normalized) ?? null;
}

function boundedText(value, maximum, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || unsafeTextPattern.test(normalized)) {
    throw new TypeError(`${label} must contain 1-${maximum} safe characters`);
  }
  return normalized;
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
