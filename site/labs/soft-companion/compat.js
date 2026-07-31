(() => {
  const replaceStateDescriptor = Object.getOwnPropertyDescriptor(History.prototype, "replaceState");
  if (!replaceStateDescriptor || typeof replaceStateDescriptor.value !== "function" || !replaceStateDescriptor.writable) {
    throw new Error("Soft Companion requires a writable History.replaceState method");
  }

  const nativeReplaceState = replaceStateDescriptor.value;
  Object.defineProperty(History.prototype, "replaceState", {
    ...replaceStateDescriptor,
    value(...args) {
      try {
        return Reflect.apply(nativeReplaceState, this, args);
      } catch (error) {
        if (error instanceof DOMException && error.name === "SecurityError") return undefined;
        throw error;
      }
    },
  });

  const policy = Object.freeze({
    projectConnections(connections, scenario) {
      if (!Array.isArray(connections)) throw new TypeError("Soft Companion connections must be an array");
      return Object.freeze(connections.map((connection) => {
        if (!connection || typeof connection !== "object") throw new TypeError("Soft Companion connection must be a record");
        if (scenario !== "degraded" || connection.id !== "github") return connection;
        return Object.freeze({
          ...connection,
          state: "degraded",
          detail: `Fictional degraded preview: issue reads current, review threads delayed. Fixture baseline: ${connection.state}.`,
        });
      }));
    },
    primaryActionLabel(action) {
      if (typeof action !== "string" || !action.trim()) throw new TypeError("Soft Companion action must be text");
      return `Preview: ${action.trim()}`;
    },
    primaryActionAnnouncement(row) {
      if (!row || typeof row !== "object" || typeof row.next !== "string") {
        throw new TypeError("Soft Companion action row must include a next action");
      }
      const prefix = row.semanticState === "ambiguous" ? "Safe recovery preview" : "Fixture-only preview";
      return `${prefix}: ${row.next}. No product action was performed.`;
    },
  });
  Object.defineProperty(globalThis, "StensiblySoftCompanionPolicy", {
    value: policy,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  const modeList = document.querySelector("#mode-list");
  if (!modeList) throw new Error("Soft Companion is missing #mode-list");

  modeList.addEventListener("click", (event) => {
    if (event.detail !== 0 || !(event.target instanceof Element)) return;
    const activated = event.target.closest("button[data-mode]");
    if (!activated || !modeList.contains(activated)) return;
    const mode = activated.dataset.mode;
    if (!mode) return;
    requestAnimationFrame(() => {
      const replacement = [...modeList.querySelectorAll("button[data-mode]")]
        .find((button) => button.dataset.mode === mode);
      replacement?.focus();
    });
  }, { capture: true });
})();
