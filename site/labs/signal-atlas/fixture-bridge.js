(() => {
  const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
  if (!fixtureApi) throw new Error("Signal Atlas requires the shared frontend labs fixture contract");

  const fixture = fixtureApi.frontendLabFixture;
  const decision = requiredFixtureRecord(fixture.decision, "decision");
  const workers = fixture.workers.map((entry, index) => requiredFixtureRecord(entry, `worker ${index + 1}`));
  const recommended = requiredFixtureRecord(fixture.readyWork[0], "top ready work");
  const ambiguous = requiredFixtureRecord(fixture.operations[0], "ambiguous operation");
  const recovered = requiredFixtureRecord(fixture.operations[2], "recovered operation");
  const connections = fixture.connections.map((entry, index) => requiredFixtureRecord(entry, `connection ${index + 1}`));

  const sharedRecords = new Map([
    [decision.id, { kind: "decision", source: decision }],
    ...workers.map((entry) => [entry.id, { kind: "worker", source: entry }]),
    [recommended.id, { kind: "ready work", source: recommended }],
    [ambiguous.id, { kind: "operation", source: ambiguous }],
    [recovered.id, { kind: "operation", source: recovered }],
    ...connections.map((entry) => [entry.id, { kind: "connection", source: entry }]),
  ]);

  const ledgerChapterIds = Object.freeze({
    ember: "workers",
    "archive-coral": "ambiguity",
    "deploy-amber": "ambiguity",
    moss: "workers",
    api: "connections",
    "approve-release-note": "decision",
  });

  const policy = Object.freeze({
    projectRecords(baseRecords) {
      if (!Array.isArray(baseRecords)) throw new TypeError("Signal Atlas base records must be an array");
      const ids = baseRecords.map((entry) => {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.kind !== "string") {
          throw new TypeError("Signal Atlas base records must contain record identities and kinds");
        }
        return entry.id;
      });
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
        if (typeof state !== "string" || typeof title !== "string" || typeof summary !== "string") {
          throw new TypeError(`Signal Atlas record ${base.id} is missing shared presentation text`);
        }
        const nextAction = base.kind === "operation" && typeof source.action === "string"
          ? `${source.action}. ${base.nextAction}`
          : base.nextAction;
        return Object.freeze({ ...base, state, title, summary, nextAction });
      }));
    },
    ledgerChapter(recordId) {
      if (typeof recordId !== "string") throw new TypeError("Signal Atlas ledger record id must be text");
      const chapterId = ledgerChapterIds[recordId];
      if (!chapterId) throw new TypeError(`Signal Atlas ledger event ${recordId} requires an explicit chapter`);
      const chapterEntry = chapters.find((entry) => entry.id === chapterId);
      if (!chapterEntry || !chapterEntry.active.includes(recordId)) {
        throw new TypeError(`Signal Atlas chapter ${chapterId} must contain ledger record ${recordId}`);
      }
      return chapterId;
    },
  });

  const ledgerIds = ledgerEvents.map((entry) => entry.recordId);
  if (new Set(ledgerIds).size !== ledgerIds.length) throw new TypeError("Signal Atlas ledger record identities must be unique");
  if (Object.keys(ledgerChapterIds).sort().join(",") !== [...ledgerIds].sort().join(",")) {
    throw new TypeError("Signal Atlas ledger destinations must cover every event exactly");
  }
  for (const id of ledgerIds) policy.ledgerChapter(id);

  const projectedRecords = policy.projectRecords(records);

  Object.defineProperty(globalThis, "StensiblySignalAtlasPolicy", {
    value: policy,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  byId = function sharedSignalAtlasRecord(id) {
    const entry = projectedRecords.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown Signal Atlas record: ${id}`);
    return entry;
  };

  renderMap = function renderSharedSignalAtlasMap(entry) {
    mapNodes.replaceChildren(...projectedRecords.map((recordEntry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-node";
      button.dataset.recordId = recordEntry.id;
      button.dataset.state = recordEntry.state;
      button.style.left = `${recordEntry.position[0]}%`;
      button.style.top = `${recordEntry.position[1]}%`;
      button.hidden = !entry.active.includes(recordEntry.id);
      button.setAttribute("aria-current", String(recordEntry.id === selectedRecordId));
      button.setAttribute("aria-label", `${recordEntry.title}. ${stateLabels[recordEntry.state]}. ${recordEntry.summary}`);
      button.append(
        text("span", symbolFor(recordEntry.state), "node-symbol"),
        text("strong", recordEntry.title),
        text("small", stateLabels[recordEntry.state]),
      );
      button.addEventListener("click", () => selectRecord(recordEntry.id, button));
      return button;
    }));
  };

  renderEvidence = function renderSharedSignalAtlasEvidence() {
    const recordEntry = byId(selectedRecordId);
    const providerEntries = ["github", "api", "mcp"].map(byId);
    evidenceBody.replaceChildren(
      text("span", stateLabels[recordEntry.state], "evidence-state"),
      text("h2", recordEntry.title, "evidence-title"),
      text("p", recordEntry.summary, "evidence-copy"),
      section("Exact evidence", evidenceList([
        ["Identity", recordEntry.id],
        ["Kind", recordEntry.kind],
        ["Owner", recordEntry.owner],
        ["Observed", recordEntry.time],
        ["Evidence head", recordEntry.evidence],
        ["Source", "Paper Lantern shared fictional fixture"],
      ])),
      section("Safe next action", elementWithChildren("div", "next-action", text("strong", recordEntry.nextAction))),
      section("Available providers", evidenceList(providerEntries.map((entry) => [entry.title, stateLabels[entry.state]]))),
    );
  };

  renderLedger = function renderExplicitSignalAtlasLedger() {
    ledgerList.replaceChildren(...ledgerEvents.map((entry) => {
      const recordEntry = byId(entry.recordId);
      const chapterId = policy.ledgerChapter(entry.recordId);
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.recordId = entry.recordId;
      button.dataset.chapterId = chapterId;
      button.textContent = `Open ${recordEntry.title}`;
      button.addEventListener("click", () => {
        closeLedger(false);
        const targetIndex = chapters.findIndex((chapterEntry) => chapterEntry.id === chapterId);
        if (targetIndex < 0) throw new Error(`Unknown Signal Atlas chapter: ${chapterId}`);
        chapterIndex = targetIndex;
        selectedRecordId = entry.recordId;
        renderChapterList();
        renderChapter();
        evidenceBody.focus({ preventScroll: true });
        announce(`${recordEntry.title} selected from the complete ledger`);
      });
      item.append(
        text("time", entry.time),
        elementWithChildren("div", "", text("code", stateLabels[recordEntry.state]), text("strong", recordEntry.title)),
        elementWithChildren("div", "", text("p", entry.copy), button),
      );
      return item;
    }));
  };

  renderLedger();
  renderChapter();

  function requiredFixtureRecord(value, label) {
    if (!value || typeof value !== "object" || typeof value.id !== "string") {
      throw new TypeError(`Signal Atlas shared ${label} is missing`);
    }
    return value;
  }
})();
