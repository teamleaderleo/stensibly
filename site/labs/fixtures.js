const globalName = "StensiblyFrontendLabFixtures";
const expectedKeys = [
  "createFrontendLabReport",
  "frontendLabFixture",
  "frontendLabTasks",
  "parseFrontendLabFixture",
  "parseFrontendLabTasks",
];

let api = apiFromDescriptor(Object.getOwnPropertyDescriptor(globalThis, globalName));

if (!Object.prototype.hasOwnProperty.call(globalThis, globalName)) {
  await import("./fixtures.classic.js");
  api = apiFromDescriptor(Object.getOwnPropertyDescriptor(globalThis, globalName));
} else if (!api) {
  throw new Error(`${globalName} is already defined with an incompatible contract`);
}

if (!api) {
  throw new Error(`${globalName} did not initialize with the expected contract`);
}

export const {
  frontendLabFixture,
  frontendLabTasks,
  parseFrontendLabFixture,
  parseFrontendLabTasks,
  createFrontendLabReport,
} = api;

function apiFromDescriptor(descriptor) {
  if (
    !descriptor
    || !("value" in descriptor)
    || descriptor.writable
    || descriptor.enumerable
    || descriptor.configurable
  ) {
    return null;
  }
  return admittedFixtureApi(descriptor.value);
}

function admittedFixtureApi(value) {
  if (
    !value
    || typeof value !== "object"
    || Object.getPrototypeOf(value) !== Object.prototype
    || !Object.isFrozen(value)
  ) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).sort().join(",") !== expectedKeys.join(",")) return null;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
  }
  const fixture = descriptors.frontendLabFixture.value;
  const tasks = descriptors.frontendLabTasks.value;
  if (!fixture || typeof fixture !== "object" || !Object.isFrozen(fixture)) return null;
  if (!Array.isArray(tasks) || !Object.isFrozen(tasks)) return null;
  if (![descriptors.parseFrontendLabFixture.value, descriptors.parseFrontendLabTasks.value, descriptors.createFrontendLabReport.value]
    .every((candidate) => typeof candidate === "function")) {
    return null;
  }
  return value;
}
