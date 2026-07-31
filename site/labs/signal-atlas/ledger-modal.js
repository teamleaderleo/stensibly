(() => {
  const ledger = document.querySelector("#ledger");
  const masthead = document.querySelector(".masthead");
  const atlas = document.querySelector(".atlas");
  if (!ledger || !masthead || !atlas) throw new Error("Signal Atlas is missing its ledger focus boundary");

  const hiddenDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden");
  if (!hiddenDescriptor?.get || !hiddenDescriptor.set || !hiddenDescriptor.configurable) {
    throw new Error("Signal Atlas requires the native HTMLElement.hidden accessor");
  }

  const policy = Object.freeze({
    projectRecords(fixture, metadataEntries) {
      if (!fixture || typeof fixture !== "object") throw new TypeError("Signal Atlas requires a shared fixture record");
      if (!Array.isArray(metadataEntries)) throw new TypeError("Signal Atlas metadata must be an array");

      const shared = new Map([
        [fixture.decision?.id, { kind: "decision", source: fixture.decision }],
        ...(fixture.workers ?? []).map((entry) => [entry.id, { kind: "worker", source: entry }]),
        ...(fixture.readyWork ?? []).map((entry) => [entry.id, { kind: "ready work", source: entry }]),
        ...(fixture.operations ?? []).map((entry) => [entry.id, { kind: "operation", source: entry }]),
        ...(fixture.connections ?? []).map((entry) => [entry.id, { kind: "connection", source: entry }]),
      ]);
      const ids = metadataEntries.map((entry) => entry?.id);
      if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
        throw new TypeError("Signal Atlas metadata identities must be unique text");
      }

      return Object.freeze(metadataEntries.map((metadata) => {
        const sharedEntry = shared.get(metadata.id);
        if (!sharedEntry || sharedEntry.kind !== metadata.kind) {
          throw new TypeError(`Signal Atlas record ${metadata.id} must match a shared fixture identity and kind`);
        }
        const source = sharedEntry.source;
        const title = source.title ?? source.label;
        const summary = source.detail ?? source.reason;
        const state = metadata.kind === "decision" ? "attention" : source.state;
        const nextAction = metadata.kind === "operation" ? source.action : metadata.nextAction;
        if (![title, summary, state, nextAction].every((value) => typeof value === "string" && value.trim())) {
          throw new TypeError(`Signal Atlas record ${metadata.id} is missing shared presentation truth`);
        }
        return Object.freeze({ ...metadata, title, summary, state, nextAction });
      }));
    },

    chapterIndex(chapters, chapterId, recordId) {
      if (!Array.isArray(chapters) || typeof chapterId !== "string" || typeof recordId !== "string") {
        throw new TypeError("Signal Atlas ledger destination must name a chapter and record");
      }
      const index = chapters.findIndex((chapter) => chapter?.id === chapterId);
      if (index < 0 || !Array.isArray(chapters[index].active) || !chapters[index].active.includes(recordId)) {
        throw new TypeError(`Signal Atlas ledger destination ${chapterId}/${recordId} is invalid`);
      }
      return index;
    },

    returnFocusTarget(candidate, fallback, ledgerElement, bodyElement) {
      if (!(fallback instanceof HTMLElement) || typeof fallback.focus !== "function") {
        throw new TypeError("Signal Atlas ledger requires a focusable fallback");
      }
      if (!(candidate instanceof HTMLElement) || candidate === bodyElement || !candidate.isConnected) return fallback;
      if (ledgerElement.contains(candidate)) return fallback;
      const focusable = candidate.matches('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
      return focusable && !candidate.hidden && !candidate.inert ? candidate : fallback;
    },
  });

  Object.defineProperty(globalThis, "StensiblySignalAtlasPolicy", {
    value: policy,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  Object.defineProperty(ledger, "hidden", {
    configurable: true,
    enumerable: hiddenDescriptor.enumerable,
    get() {
      return Reflect.apply(hiddenDescriptor.get, this, []);
    },
    set(value) {
      const hidden = Boolean(value);
      masthead.inert = !hidden;
      atlas.inert = !hidden;
      Reflect.apply(hiddenDescriptor.set, this, [hidden]);
    },
  });

  ledger.setAttribute("role", "dialog");
  ledger.setAttribute("aria-modal", "true");
  ledger.hidden = ledger.hidden;
})();
