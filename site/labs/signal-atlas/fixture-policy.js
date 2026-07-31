(() => {
  const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
  if (!fixtureApi) throw new Error("Signal Atlas policy requires the shared frontend labs fixture contract");

  const fixture = fixtureApi.frontendLabFixture;
  const taskIds = new Set(fixtureApi.frontendLabTasks.map((task) => task.id));
  const sharedRecords = new Map([
    [fixture.decision.id, { kind: "decision", source: fixture.decision }],
    ...fixture.workers.map((entry) => [entry.id, { kind: "worker", source: entry }]),
    [fixture.readyWork[0]?.id, { kind: "ready work", source: fixture.readyWork[0] }],
    [fixture.operations[0]?.id, { kind: "operation", source: fixture.operations[0] }],
    [fixture.operations[2]?.id, { kind: "operation", source: fixture.operations[2] }],
    ...fixture.connections.map((entry) => [entry.id, { kind: "connection", source: entry }]),
  ]);
  if ([...sharedRecords.keys()].some((id) => typeof id !== "string")) {
    throw new TypeError("Signal Atlas shared fixture subset is incomplete");
  }

  const metadataKeys = ["evidence", "id", "kind", "nextAction", "owner", "position", "task", "time"];
  const policy = Object.freeze({
    projectRecords(value) {
      if (!Array.isArray(value)) throw new TypeError("Signal Atlas base records must be an array");
      const baseRecords = value.map((entry, index) => admitMetadata(entry, index));
      const ids = baseRecords.map((entry) => entry.id);
      if (new Set(ids).size !== ids.length) throw new TypeError("Signal Atlas base record identities must be unique");
      if (ids.length !== sharedRecords.size || ids.some((id) => !sharedRecords.has(id))) {
        throw new TypeError("Signal Atlas base records must match the admitted shared fixture subset");
      }

      return Object.freeze(baseRecords.map((base) => {
        const shared = sharedRecords.get(base.id);
        if (!shared || shared.kind !== base.kind) {
          throw new TypeError(`Signal Atlas record ${base.id} must keep its shared fixture kind`);
        }
        const source = shared.source;
        const state = base.kind === "decision" ? "attention" : source.state;
        const title = source.title ?? source.label;
        const summary = source.detail ?? source.reason;
        const nextAction = base.kind === "operation" && typeof source.action === "string"
          ? `${source.action}: ${base.nextAction}`
          : base.nextAction;
        if (typeof state !== "string" || typeof title !== "string" || typeof summary !== "string") {
          throw new TypeError(`Signal Atlas record ${base.id} is missing shared presentation text`);
        }
        return Object.freeze({ ...base, state, title, summary, nextAction });
      }));
    },
  });

  function admitMetadata(value, index) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Signal Atlas base record ${index + 1} must be an object without symbol fields`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).sort().join(",") !== metadataKeys.join(",")) {
      throw new TypeError(`Signal Atlas base record ${index + 1} must use exact metadata fields`);
    }
    const record = {};
    for (const key of metadataKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`Signal Atlas metadata field ${key} must be an enumerable data property`);
      }
      record[key] = descriptor.value;
    }
    for (const key of ["id", "kind", "owner", "time", "evidence", "nextAction"]) {
      if (typeof record[key] !== "string" || !record[key].trim()) {
        throw new TypeError(`Signal Atlas metadata field ${key} must be non-empty text`);
      }
    }
    if (record.task !== null && (typeof record.task !== "string" || !taskIds.has(record.task))) {
      throw new TypeError(`Unknown Signal Atlas task identity: ${record.task}`);
    }
    if (!Array.isArray(record.position) || record.position.length !== 2 || !record.position.every(Number.isFinite)) {
      throw new TypeError(`Signal Atlas record ${record.id} requires one finite landscape position`);
    }
    return Object.freeze({ ...record, position: Object.freeze([...record.position]) });
  }

  Object.defineProperty(globalThis, "StensiblySignalAtlasPolicy", {
    value: policy,
    writable: false,
    enumerable: false,
    configurable: false,
  });
})();
