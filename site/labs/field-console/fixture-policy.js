(() => {
  const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
  if (!fixtureApi) throw new Error("Field Console policy requires the shared frontend labs fixture contract");

  const fixture = fixtureApi.frontendLabFixture;
  const taskIds = new Set(fixtureApi.frontendLabTasks.map((task) => task.id));
  const sharedRecords = new Map([
    [fixture.decision.id, { kind: "decision", source: fixture.decision }],
    ...fixture.workers.map((entry) => [entry.id, { kind: "worker", source: entry }]),
    ...fixture.readyWork.map((entry) => [entry.id, { kind: "ready work", source: entry }]),
    ...fixture.operations.map((entry) => [entry.id, { kind: "operation", source: entry }]),
    ...fixture.connections.map((entry) => [entry.id, { kind: "connection", source: entry }]),
  ]);
  const scenarios = new Set(["default", "empty", "degraded", "error"]);
  const metadataKeys = ["evidence", "id", "kind", "nextAction", "owner", "position", "priority", "task", "timestamp"];

  const policy = Object.freeze({
    projectRecords(value, scenario) {
      if (!Array.isArray(value)) throw new TypeError("Field Console base records must be an array");
      if (!scenarios.has(scenario)) throw new TypeError(`Unsupported Field Console scenario: ${scenario}`);

      const baseRecords = value.map((entry, index) => admitMetadata(entry, index));
      const ids = baseRecords.map((entry) => entry.id);
      if (new Set(ids).size !== ids.length) throw new TypeError("Field Console base record identities must be unique");
      if (ids.length !== sharedRecords.size || ids.some((id) => !sharedRecords.has(id))) {
        throw new TypeError("Field Console base records must match the shared fixture identities");
      }

      return Object.freeze(baseRecords.map((base) => {
        const shared = sharedRecords.get(base.id);
        if (!shared || shared.kind !== base.kind) {
          throw new TypeError(`Field Console record ${base.id} must keep its shared fixture kind`);
        }
        const source = shared.source;
        const state = base.kind === "decision" ? "attention" : source.state;
        const title = source.title ?? source.label;
        const summary = source.detail ?? source.reason;
        const nextAction = base.kind === "operation" ? source.action : base.nextAction;
        if (typeof title !== "string" || typeof summary !== "string" || typeof nextAction !== "string") {
          throw new TypeError(`Field Console record ${base.id} is missing shared presentation text`);
        }
        const projectedSummary = scenario === "degraded" && base.id === "sync-violet"
          ? "Review-thread evidence is delayed by 18 minutes; issue reads remain current."
          : summary;
        return Object.freeze({
          ...base,
          state,
          title,
          summary: projectedSummary,
          nextAction,
          actionLabel: state === "ambiguous" ? "Read safe next action" : "Read next action",
        });
      }));
    },
  });

  function admitMetadata(value, index) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Field Console base record ${index + 1} must be an object without symbol fields`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).sort().join(",") !== metadataKeys.join(",")) {
      throw new TypeError(`Field Console base record ${index + 1} must use exact metadata fields`);
    }
    const record = {};
    for (const key of metadataKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`Field Console metadata field ${key} must be an enumerable data property`);
      }
      record[key] = descriptor.value;
    }
    for (const key of ["id", "kind", "owner", "timestamp", "evidence", "nextAction"]) {
      if (typeof record[key] !== "string" || !record[key].trim()) {
        throw new TypeError(`Field Console metadata field ${key} must be non-empty text`);
      }
    }
    if (!Number.isSafeInteger(record.priority) || record.priority < 1 || record.priority > 99) {
      throw new TypeError(`Field Console record ${record.id} priority must be 1-99`);
    }
    if (record.task !== null && (typeof record.task !== "string" || !taskIds.has(record.task))) {
      throw new TypeError(`Unknown Field Console task identity: ${record.task}`);
    }
    if (!Array.isArray(record.position) || record.position.length !== 2 || !record.position.every(Number.isFinite)) {
      throw new TypeError(`Field Console record ${record.id} requires one finite topology position`);
    }
    return Object.freeze({ ...record, position: Object.freeze([...record.position]) });
  }

  Object.defineProperty(globalThis, "StensiblyFieldConsolePolicy", {
    value: policy,
    writable: false,
    enumerable: false,
    configurable: false,
  });
})();
