(() => {
  const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
  if (!fixtureApi) throw new Error("Field Console requires the shared frontend labs fixture contract");

  const fixture = fixtureApi.frontendLabFixture;
  const sharedRecords = new Map([
    [fixture.decision.id, { kind: "decision", source: fixture.decision }],
    ...fixture.workers.map((entry) => [entry.id, { kind: "worker", source: entry }]),
    ...fixture.readyWork.map((entry) => [entry.id, { kind: "ready work", source: entry }]),
    ...fixture.operations.map((entry) => [entry.id, { kind: "operation", source: entry }]),
    ...fixture.connections.map((entry) => [entry.id, { kind: "connection", source: entry }]),
  ]);

  const policy = Object.freeze({
    projectRecords(baseRecords, scenarioValue) {
      if (!Array.isArray(baseRecords)) throw new TypeError("Field Console base records must be an array");
      const baseIds = baseRecords.map((entry) => {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.kind !== "string") {
          throw new TypeError("Field Console base records must contain record identities and kinds");
        }
        return entry.id;
      });
      if (new Set(baseIds).size !== baseIds.length) throw new TypeError("Field Console base record identities must be unique");
      if (baseIds.length !== sharedRecords.size || baseIds.some((id) => !sharedRecords.has(id))) {
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
        const projectedSummary = scenarioValue === "degraded" && base.id === "sync-violet"
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

  Object.defineProperty(globalThis, "StensiblyFieldConsolePolicy", {
    value: policy,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  const baseRecords = records;
  let cachedScenario = null;
  let cachedRecords = null;

  scenarioRecords = function scenarioProjectedRecords() {
    if (cachedScenario !== scenario || !cachedRecords) {
      cachedScenario = scenario;
      cachedRecords = policy.projectRecords(baseRecords, scenario);
    }
    return cachedRecords;
  };

  byId = function projectedRecordById(id) {
    const entry = scenarioRecords().find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown Field Console record: ${id}`);
    return entry;
  };

  renderHealth = function renderProjectedHealth() {
    const container = required("#connection-health");
    const connections = scenarioRecords().filter((entry) => entry.kind === "connection");
    container.replaceChildren(...connections.map((entry) => stateChip(entry.state, `${entry.title} ${stateLabels[entry.state]}`)));
  };

  renderAll();
})();
