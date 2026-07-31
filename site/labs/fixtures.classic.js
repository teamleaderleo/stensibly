(() => {
  const globalName = "StensiblyFrontendLabFixtures";
  const apiKeys = [
    "createFrontendLabReport",
    "frontendLabFixture",
    "frontendLabTasks",
    "parseFrontendLabFixture",
    "parseFrontendLabTasks",
  ];
  if (Object.prototype.hasOwnProperty.call(globalThis, globalName)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, globalName);
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.writable
      || descriptor.enumerable
      || descriptor.configurable
      || !isCompatibleApi(descriptor.value)
    ) {
      throw new Error(`${globalName} is already defined with an incompatible contract`);
    }
    return;
  }

  const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
  const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const states = new Set(["healthy", "unhealthy", "ready", "blocked", "stale", "failed", "degraded", "ambiguous", "recovered", "offline", "reconnecting", "denied", "incompatible"]);
  const fixtureKeys = ["connections", "decision", "operations", "project", "readyWork", "references", "workers"];
  const taskKeys = ["id", "prompt", "start", "success"];

  const sourceFixture = {
    project: { id: "paper-lantern", name: "Paper Lantern", summary: "A fictional release workspace for comparing frontend concepts." },
    decision: { id: "approve-release-note", state: "ready", title: "Approve the release note", detail: "Choose the concise wording before publication." },
    workers: [
      { id: "moss", state: "healthy", label: "Moss", detail: "Reviewing accessibility evidence." },
      { id: "ember", state: "unhealthy", label: "Ember", detail: "Lease expired 12 minutes ago; safe reassignment is available." },
    ],
    readyWork: [
      { id: "repair-focus-order", state: "ready", rank: 1, title: "Repair focus order", reason: "Unblocks keyboard evidence across every variant." },
      { id: "polish-empty-state", state: "ready", rank: 2, title: "Polish empty state", reason: "Improves clarity after the shared contract lands." },
    ],
    operations: [
      { id: "deploy-amber", state: "ambiguous", title: "Dashboard publication", detail: "Provider receipt is missing; reconcile before retry.", action: "Reconcile publication" },
      { id: "sync-violet", state: "degraded", title: "GitHub context sync", detail: "Issue reads are current; review threads are delayed.", action: "View evidence" },
      { id: "archive-coral", state: "recovered", title: "Artifact archive", detail: "Recovered from a stale lease without duplicate writes.", action: "Open activity" },
    ],
    connections: [
      { id: "github", state: "healthy", label: "GitHub", detail: "Read and bounded write capabilities available." },
      { id: "api", state: "reconnecting", label: "API", detail: "Refreshing a fictional short-lived session." },
      { id: "mcp", state: "offline", label: "MCP", detail: "Unavailable in this preview scenario." },
    ],
    references: [
      { kind: "issue", label: "Issue #742", value: "github:paper-lantern/studio#742" },
      { kind: "revision", label: "Revision", value: "7ac91de" },
      { kind: "deployment", label: "Deployment", value: "preview-amber-17" },
      { kind: "artifact", label: "Artifact", value: "keyboard-evidence.json" },
    ],
  };

  const sourceTasks = [
    { id: "human-decision", prompt: "Find the only item needing a human decision.", start: "project-overview", success: "approve-release-note" },
    { id: "worker-health", prompt: "Identify every active worker and the unhealthy lease.", start: "project-overview", success: "ember" },
    { id: "recommended-work", prompt: "Explain why the top ready item is recommended.", start: "ready-work", success: "repair-focus-order" },
    { id: "safe-reconciliation", prompt: "Locate the ambiguous operation and its safe next action.", start: "operations", success: "deploy-amber" },
    { id: "connection-health", prompt: "Determine GitHub, API, and MCP connection health.", start: "connections", success: "github,api,mcp" },
  ];

  function parseFrontendLabFixture(value) {
    exactRecord(value, fixtureKeys, "Frontend labs fixture");
    const parsed = {
      project: parseEntity(value.project, ["id", "name", "summary"], "project"),
      decision: parseStateEntity(value.decision, ["detail", "id", "state", "title"], "decision"),
      workers: parseList(value.workers, 1, 8, (entry, index) => parseStateEntity(entry, ["detail", "id", "label", "state"], `worker ${index + 1}`)),
      readyWork: parseList(value.readyWork, 1, 12, (entry, index) => {
        exactRecord(entry, ["id", "rank", "reason", "state", "title"], `ready work ${index + 1}`);
        if (!Number.isSafeInteger(entry.rank) || entry.rank < 1 || entry.rank > 99) throw new TypeError("Ready work rank must be 1-99");
        return Object.freeze({ id: slug(entry.id, "Ready work id"), rank: entry.rank, reason: text(entry.reason, 240, "Ready work reason"), state: state(entry.state), title: text(entry.title, 100, "Ready work title") });
      }),
      operations: parseList(value.operations, 1, 12, (entry, index) => parseStateEntity(entry, ["action", "detail", "id", "state", "title"], `operation ${index + 1}`)),
      connections: parseList(value.connections, 1, 8, (entry, index) => parseStateEntity(entry, ["detail", "id", "label", "state"], `connection ${index + 1}`)),
      references: parseList(value.references, 1, 12, (entry, index) => parseEntity(entry, ["kind", "label", "value"], `reference ${index + 1}`)),
    };
    return deepFreeze(parsed);
  }

  function parseFrontendLabTasks(value) {
    return Object.freeze(parseList(value, 1, 20, (entry, index) => {
      exactRecord(entry, taskKeys, `task ${index + 1}`);
      return Object.freeze({ id: slug(entry.id, "Task id"), prompt: text(entry.prompt, 180, "Task prompt"), start: slug(entry.start, "Task start"), success: text(entry.success, 120, "Task success") });
    }));
  }

  const frontendLabFixture = parseFrontendLabFixture(sourceFixture);
  const frontendLabTasks = parseFrontendLabTasks(sourceTasks);

  function createFrontendLabReport(taskIds = frontendLabTasks.map((task) => task.id)) {
    const allowed = new Set(frontendLabTasks.map((task) => task.id));
    const tasks = taskIds.map((id) => {
      const normalized = slug(id, "Report task id");
      if (!allowed.has(normalized)) throw new TypeError(`Unknown report task: ${normalized}`);
      return Object.freeze({ taskId: normalized, elapsedMs: null, wrongTurns: 0, scrollDistance: 0, targetMisses: 0, terminologyConfusion: "", comfort: "", delight: "" });
    });
    return deepFreeze({ version: 1, tasks });
  }

  function parseStateEntity(value, keys, label) {
    exactRecord(value, keys, label);
    const result = {};
    for (const key of keys) result[key] = key === "id" ? slug(value[key], `${label} id`) : key === "state" ? state(value[key]) : text(value[key], 240, `${label} ${key}`);
    return Object.freeze(result);
  }
  function parseEntity(value, keys, label) { exactRecord(value, keys, label); const result = {}; for (const key of keys) result[key] = key === "id" ? slug(value[key], `${label} id`) : text(value[key], 240, `${label} ${key}`); return Object.freeze(result); }
  function parseList(value, minimum, maximum, parser) { if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new TypeError(`Expected ${minimum}-${maximum} entries`); return Object.freeze(value.map(parser)); }
  function exactRecord(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be an object`); if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new TypeError(`${label} must use exact fields`); }
  function state(value) { const normalized = text(value, 24, "State"); if (!states.has(normalized)) throw new TypeError(`Unsupported state: ${normalized}`); return normalized; }
  function slug(value, label) { const normalized = text(value, 64, label); if (!idPattern.test(normalized)) throw new TypeError(`${label} must be a lowercase slug`); return normalized; }
  function text(value, maximum, label) { if (typeof value !== "string") throw new TypeError(`${label} must be text`); const normalized = value.trim(); if (!normalized || normalized.length > maximum || unsafeTextPattern.test(normalized)) throw new TypeError(`${label} must contain 1-${maximum} safe characters`); return normalized; }
  function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const nested of Object.values(value)) deepFreeze(nested); } return value; }
  function isCompatibleApi(value) {
    return Boolean(value)
      && typeof value === "object"
      && Object.getPrototypeOf(value) === Object.prototype
      && Object.isFrozen(value)
      && Object.keys(value).sort().join(",") === apiKeys.join(",")
      && typeof value.parseFrontendLabFixture === "function"
      && typeof value.parseFrontendLabTasks === "function"
      && typeof value.createFrontendLabReport === "function"
      && Object.isFrozen(value.frontendLabFixture)
      && Object.isFrozen(value.frontendLabTasks);
  }

  const api = Object.freeze({ frontendLabFixture, frontendLabTasks, parseFrontendLabFixture, parseFrontendLabTasks, createFrontendLabReport });
  Object.defineProperty(globalThis, globalName, { value: api, writable: false, enumerable: false, configurable: false });
})();
