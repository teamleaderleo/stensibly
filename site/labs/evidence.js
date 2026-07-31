import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { frontendLabFixture, frontendLabTasks } from "./fixtures.js";
import { frontendLabManifest } from "./manifest.js";

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const revisionPattern = /^[a-f0-9]{64}$/;
const evidenceInputKeys = ["profileIds", "taskIds", "variantIds"];
const evidenceRevisionInputKeys = ["fixtureRevision", "manifest", "profiles", "scenarios", "version"];
const evidenceProfileKeys = ["height", "id", "requiredSupport", "taskEligible", "width", "zoomPercent"];
const maximumCaseIdLength = 220;
const maximumArtifactStemLength = 240;
const viewportSupport = new Set(["wide", "medium", "narrow"]);

export const frontendLabEvidencePlanVersion = 2;
export const frontendLabEvidenceIdentityLimits = Object.freeze({
  maximumDepth: 32,
  maximumNodes: 512,
  maximumStringBytes: 4_096,
  maximumCanonicalBytes: 16_384,
});

const sourceProfiles = [
  { id: "wide", width: 1440, height: 900, zoomPercent: 100, requiredSupport: "wide", taskEligible: true },
  { id: "medium", width: 960, height: 900, zoomPercent: 100, requiredSupport: "medium", taskEligible: false },
  { id: "narrow", width: 390, height: 844, zoomPercent: 100, requiredSupport: "narrow", taskEligible: true },
  { id: "zoom-200", width: 1440, height: 900, zoomPercent: 200, requiredSupport: "wide", taskEligible: true },
];

const sourceScenarios = [
  { id: "default", requiredSupport: null },
  { id: "empty", requiredSupport: "empty" },
  { id: "loading", requiredSupport: "loading" },
  { id: "degraded", requiredSupport: "degraded" },
  { id: "error", requiredSupport: "error" },
];

export const frontendLabEvidenceProfiles = Object.freeze(sourceProfiles.map((profile) => Object.freeze({ ...profile })));
export const frontendLabEvidenceScenarios = Object.freeze(sourceScenarios.map((scenario) => Object.freeze({ ...scenario })));

export function createFrontendLabFixtureRevision(fixture, tasks) {
  return sha256({ fixture, tasks });
}

export function createFrontendLabEvidencePlanRevision(input) {
  const record = exactDataRecord(input, evidenceRevisionInputKeys, "Frontend labs evidence revision input");
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    throw new TypeError("Frontend labs evidence revision version must be a positive safe integer");
  }
  if (typeof record.fixtureRevision !== "string" || !revisionPattern.test(record.fixtureRevision)) {
    throw new TypeError("Frontend labs evidence fixture revision must be a lowercase SHA-256 identity");
  }
  return sha256(record);
}

export function validateFrontendLabEvidenceVariant(variant, profiles = frontendLabEvidenceProfiles) {
  evidenceCoverage(variant, profiles);
}

export function createFrontendLabEvidencePlan(input = {}) {
  const parsedInput = optionalDataRecord(input, evidenceInputKeys, "Frontend labs evidence input");
  const variants = select(frontendLabManifest, parsedInput.variantIds, "variant");
  const profiles = select(frontendLabEvidenceProfiles, parsedInput.profileIds, "profile");
  const tasks = select(frontendLabTasks, parsedInput.taskIds, "task");
  const fixtureRevision = createFrontendLabFixtureRevision(frontendLabFixture, frontendLabTasks);
  const planRevision = createFrontendLabEvidencePlanRevision({
    version: frontendLabEvidencePlanVersion,
    profiles: frontendLabEvidenceProfiles,
    scenarios: frontendLabEvidenceScenarios,
    manifest: frontendLabManifest,
    fixtureRevision,
  });
  const cases = [];

  for (const variant of variants) {
    const { supportedProfiles, schemes } = evidenceCoverage(variant, profiles);
    const motions = variant.support.includes("reduced-motion") ? ["no-preference", "reduce"] : ["no-preference"];
    const scenarios = frontendLabEvidenceScenarios.filter((scenario) => scenario.requiredSupport === null || variant.support.includes(scenario.requiredSupport));
    const routeStart = cases.length;

    for (const profile of supportedProfiles) {
      for (const colorScheme of schemes) {
        for (const motion of motions) {
          for (const scenario of scenarios) {
            cases.push(evidenceCase({ kind: "route", variant, profile, colorScheme, motion, scenario, task: null, fixtureRevision, planRevision }));
          }
        }
      }
    }

    if (!cases.slice(routeStart).some((entry) => entry.kind === "route" && entry.variantId === variant.id)) {
      throw new TypeError(`Frontend labs variant ${variant.id} must emit at least one route evidence case`);
    }

    if (variant.status !== "prototype") continue;
    for (const profile of supportedProfiles.filter((profile) => profile.taskEligible)) {
      for (const colorScheme of schemes) {
        for (const motion of motions) {
          for (const task of tasks) {
            cases.push(evidenceCase({ kind: "task", variant, profile, colorScheme, motion, scenario: frontendLabEvidenceScenarios[0], task, fixtureRevision, planRevision }));
          }
        }
      }
    }
  }

  if (cases.length < 1 || cases.length > 1000) throw new TypeError("Frontend labs evidence plan must contain 1-1000 cases");
  const ids = new Set(cases.map((entry) => entry.id));
  if (ids.size !== cases.length) throw new TypeError("Frontend labs evidence case ids must be unique");
  return deepFreeze({
    version: frontendLabEvidencePlanVersion,
    fixtureId: frontendLabFixture.project.id,
    fixtureRevision,
    planRevision,
    cases,
  });
}

function evidenceCoverage(variant, profiles) {
  const record = dataRecord(variant, "Frontend labs evidence variant");
  const id = slug(record.id, "Frontend labs evidence variant id");
  if (record.status !== "planned" && record.status !== "prototype") {
    throw new TypeError(`Frontend labs evidence variant ${id} has an unsupported status`);
  }
  const support = denseDataArray(record.support, `Frontend labs evidence variant ${id} support`)
    .map((value) => slug(value, `Frontend labs evidence variant ${id} support value`));
  const admittedProfiles = denseDataArray(profiles, "Frontend labs evidence profiles").map((profile, index) => {
    const profileRecord = exactDataRecord(profile, evidenceProfileKeys, `Frontend labs evidence profile ${index + 1}`);
    const requiredSupport = slug(profileRecord.requiredSupport, `Frontend labs evidence profile ${index + 1} required support`);
    if (!viewportSupport.has(requiredSupport)) {
      throw new TypeError(`Frontend labs evidence profile ${index + 1} has unsupported viewport support`);
    }
    if (typeof profileRecord.taskEligible !== "boolean") {
      throw new TypeError(`Frontend labs evidence profile ${index + 1} task eligibility must be boolean`);
    }
    for (const [field, value] of [["width", profileRecord.width], ["height", profileRecord.height], ["zoom", profileRecord.zoomPercent]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new TypeError(`Frontend labs evidence profile ${index + 1} ${field} must be a bounded positive integer`);
      }
    }
    return Object.freeze({
      id: slug(profileRecord.id, `Frontend labs evidence profile ${index + 1} id`),
      width: profileRecord.width,
      height: profileRecord.height,
      zoomPercent: profileRecord.zoomPercent,
      requiredSupport,
      taskEligible: profileRecord.taskEligible,
    });
  });
  const supportedProfiles = admittedProfiles.filter((profile) => support.includes(profile.requiredSupport));
  if (supportedProfiles.length < 1) {
    throw new TypeError(`Frontend labs variant ${id} requires at least one selected supported evidence profile`);
  }
  const schemes = ["light", "dark"].filter((scheme) => support.includes(scheme));
  if (schemes.length < 1) {
    throw new TypeError(`Frontend labs variant ${id} requires at least one supported color scheme`);
  }
  if (record.status === "prototype") {
    if (!support.includes("keyboard")) {
      throw new TypeError(`Frontend labs prototype ${id} requires keyboard support for shared task evidence`);
    }
    if (!supportedProfiles.some((profile) => profile.taskEligible)) {
      throw new TypeError(`Frontend labs prototype ${id} requires at least one selected task-eligible evidence profile`);
    }
  }
  return Object.freeze({ supportedProfiles: Object.freeze(supportedProfiles), schemes: Object.freeze(schemes) });
}

function evidenceCase({ kind, variant, profile, colorScheme, motion, scenario, task, fixtureRevision, planRevision }) {
  const taskPart = task ? `--${task.id}` : "";
  const fixtureIdentity = fixtureRevision.slice(0, 16);
  const planIdentity = planRevision.slice(0, 16);
  const variantIdentity = variant.status === "prototype"
    ? `prototype-${variant.revision}`
    : "planned-unreviewed";
  const id = `${kind}--${variant.id}--${variantIdentity}--${profile.id}--${colorScheme}--${motion}--${scenario.id}${taskPart}--fixture-${fixtureIdentity}--plan-${planIdentity}`;
  if (id.length > maximumCaseIdLength) throw new TypeError(`Frontend labs evidence case id must contain at most ${maximumCaseIdLength} characters`);
  const artifactStem = `frontend-labs-${id}`;
  if (artifactStem.length > maximumArtifactStemLength) throw new TypeError(`Frontend labs evidence artifact stem must contain at most ${maximumArtifactStemLength} characters`);
  return Object.freeze({
    id,
    kind,
    variantId: variant.id,
    variantStatus: variant.status,
    variantRevision: variant.revision,
    fixtureRevision,
    planRevision,
    route: `/labs/${variant.id}/`,
    profileId: profile.id,
    viewportWidth: profile.width,
    viewportHeight: profile.height,
    zoomPercent: profile.zoomPercent,
    colorScheme,
    motion,
    scenarioId: scenario.id,
    taskId: task?.id ?? null,
    expectedIdentity: task?.success ?? variant.id,
    artifactStem,
  });
}

function select(catalog, requestedIds, label) {
  if (requestedIds === undefined) return catalog;
  const requested = denseDataArray(requestedIds, `Evidence ${label} ids`);
  if (requested.length < 1 || requested.length > 50) throw new TypeError(`Evidence ${label} ids must contain 1-50 entries`);
  const normalized = requested.map((id) => slug(id, `Evidence ${label} id`));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`Evidence ${label} ids must be unique`);
  const selected = new Set(normalized);
  for (const id of selected) {
    if (!catalog.some((entry) => entry.id === id)) throw new TypeError(`Unknown evidence ${label}: ${id}`);
  }
  return catalog.filter((entry) => selected.has(entry.id));
}

function optionalDataRecord(value, allowedKeys, label) {
  const record = dataRecord(value, label);
  const keys = Object.keys(record).sort();
  if (keys.some((key) => !allowedKeys.includes(key))) throw new TypeError(`${label} contains an unknown field`);
  return record;
}

function exactDataRecord(value, expectedKeys, label) {
  const record = dataRecord(value, label);
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== expectedKeys.join(",")) throw new TypeError(`${label} must use the exact fields`);
  return record;
}

function dataRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value).sort();
  const entries = names.map((name) => {
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} must contain enumerable data fields only`);
    }
    return [name, descriptor.value];
  });
  return Object.freeze(Object.fromEntries(entries));
}

function denseDataArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a dense default-prototype array`);
  }
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError(`${label} has an invalid length`);
  const expectedNames = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (Object.getOwnPropertyNames(value).some((name) => !expectedNames.has(name))) {
    throw new TypeError(`${label} must not contain decorated fields`);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} must contain dense enumerable data slots`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function slug(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.trim();
  if (!idPattern.test(normalized)) throw new TypeError(`${label} must be a lowercase slug`);
  return normalized;
}

function sha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  const state = {
    ancestors: new WeakSet(),
    bytes: 0,
    nodes: 0,
    parts: [],
  };
  writeCanonical(value, state, 0);
  return state.parts.join("");
}

function writeCanonical(value, state, depth) {
  if (depth > frontendLabEvidenceIdentityLimits.maximumDepth) {
    throw new TypeError(`Evidence identity exceeds maximum depth ${frontendLabEvidenceIdentityLimits.maximumDepth}`);
  }
  state.nodes += 1;
  if (state.nodes > frontendLabEvidenceIdentityLimits.maximumNodes) {
    throw new TypeError(`Evidence identity exceeds maximum node count ${frontendLabEvidenceIdentityLimits.maximumNodes}`);
  }

  if (value === null) {
    appendCanonical(state, "null");
    return;
  }
  if (typeof value === "string") {
    appendCanonicalString(state, value);
    return;
  }
  if (typeof value === "boolean") {
    appendCanonical(state, JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("Evidence identity numbers must be finite and must not be negative zero");
    appendCanonical(state, JSON.stringify(value));
    return;
  }
  if (typeof value !== "object") throw new TypeError("Evidence identity values must be JSON-compatible data");
  if (state.ancestors.has(value)) throw new TypeError("Evidence identity values must not contain cycles");

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = denseDataArray(value, "Evidence identity array");
      appendCanonical(state, "[");
      for (let index = 0; index < entries.length; index += 1) {
        if (index > 0) appendCanonical(state, ",");
        writeCanonical(entries[index], state, depth + 1);
      }
      appendCanonical(state, "]");
      return;
    }

    const record = dataRecord(value, "Evidence identity object");
    appendCanonical(state, "{");
    const keys = Object.keys(record).sort();
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) appendCanonical(state, ",");
      const key = keys[index];
      appendCanonicalString(state, key);
      appendCanonical(state, ":");
      writeCanonical(record[key], state, depth + 1);
    }
    appendCanonical(state, "}");
  } finally {
    state.ancestors.delete(value);
  }
}

function appendCanonicalString(state, value) {
  const stringBytes = Buffer.byteLength(value, "utf8");
  if (stringBytes > frontendLabEvidenceIdentityLimits.maximumStringBytes) {
    throw new TypeError(`Evidence identity string exceeds maximum ${frontendLabEvidenceIdentityLimits.maximumStringBytes} UTF-8 bytes`);
  }
  appendCanonical(state, JSON.stringify(value));
}

function appendCanonical(state, token) {
  const nextBytes = state.bytes + Buffer.byteLength(token, "utf8");
  if (nextBytes > frontendLabEvidenceIdentityLimits.maximumCanonicalBytes) {
    throw new TypeError(`Evidence identity exceeds maximum canonical size ${frontendLabEvidenceIdentityLimits.maximumCanonicalBytes} UTF-8 bytes`);
  }
  state.bytes = nextBytes;
  state.parts.push(token);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
