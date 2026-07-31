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

  const fixture = globalThis.StensiblyFrontendLabFixtures?.frontendLabFixture;
  const connectionShelf = document.querySelector("#connection-shelf");
  const detailContent = document.querySelector("#detail-content");
  const detailHeading = document.querySelector("#detail-heading");
  const primaryAction = document.querySelector("#primary-action");
  const announcer = document.querySelector("#announcer");
  if (!fixture || !connectionShelf || !detailContent || !detailHeading || !primaryAction || !announcer) return;

  const policy = Object.freeze({
    projectConnections(connections, scenario) {
      if (!Array.isArray(connections)) throw new TypeError("Soft Companion connections must be an array");
      return Object.freeze(connections.map((connection) => {
        if (!connection || typeof connection !== "object") throw new TypeError("Soft Companion connection must be a record");
        if (scenario !== "degraded" || connection.id !== "github") return connection;
        return Object.freeze({
          ...connection,
          state: "degraded",
          detail: "Fictional degraded preview: issue reads current, review threads delayed.",
        });
      }));
    },
    operationalAnnouncement(label, nextAction, safeRecovery = false) {
      if (typeof label !== "string" || !label.trim()) throw new TypeError("Soft Companion action must be text");
      if (typeof nextAction !== "string" || !nextAction.trim()) throw new TypeError("Soft Companion action must include a next action");
      const prefix = safeRecovery ? "Safe recovery preview" : "Fixture-only preview";
      return `${prefix}: ${label.trim()}. ${nextAction.trim()} No product action was performed.`;
    },
  });
  Object.defineProperty(globalThis, "StensiblySoftCompanionPolicy", {
    value: policy,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  let framePending = false;
  const selectedTone = () => detailHeading.querySelector(".state-label[data-tone]")?.dataset.tone ?? null;
  const projectedConnections = () => policy.projectConnections(
    fixture.connections,
    document.body.dataset.scenario ?? "default",
  );

  const syncConnections = () => {
    const connections = projectedConnections();
    const chips = [...connectionShelf.children];
    connections.forEach((connection, index) => {
      const chip = chips[index];
      if (!chip) return;
      const label = `${connection.label} · ${connection.state}`;
      if (chip.textContent !== label) chip.textContent = label;
      if (chip.dataset.state !== connection.state) chip.dataset.state = connection.state;
      const symbol = connection.state === "healthy" ? "✓" : connection.state === "offline" ? "×" : "△";
      if (chip.dataset.symbol !== symbol) chip.dataset.symbol = symbol;
      if (chip.title !== connection.detail) chip.title = connection.detail;
    });
    const summary = `Connection health: ${connections.map((connection) => `${connection.label} · ${connection.state}`).join(", ")}`;
    if (connectionShelf.getAttribute("aria-label") !== summary) connectionShelf.setAttribute("aria-label", summary);

    const heading = [...detailContent.querySelectorAll("h3")]
      .find((candidate) => candidate.textContent?.trim() === "Connection health");
    const section = heading?.closest("section");
    const rows = section ? [...section.querySelectorAll("li")] : [];
    connections.forEach((connection, index) => {
      const row = rows[index];
      if (!row) return;
      const label = row.children[0];
      const value = row.children[1];
      const detail = row.children[2];
      if (label && label.textContent !== connection.label) label.textContent = connection.label;
      if (value && value.textContent !== connection.state) value.textContent = connection.state;
      if (detail && detail.textContent !== connection.detail) detail.textContent = connection.detail;
    });
  };

  const syncPrimaryAction = () => {
    if (primaryAction.disabled) return;
    const tone = selectedTone();
    if (!tone || tone === "serious" || tone === "warning") return;
    if (primaryAction.textContent !== "Undo preview acknowledgement"
      && primaryAction.textContent !== "Acknowledge in preview") {
      primaryAction.textContent = "Acknowledge in preview";
    }
  };

  const sync = () => {
    framePending = false;
    syncConnections();
    syncPrimaryAction();
  };
  const scheduleSync = () => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(sync);
  };

  primaryAction.addEventListener("click", (event) => {
    if (primaryAction.disabled) return;
    const tone = selectedTone();
    if (tone !== "serious" && tone !== "warning") return;
    const nextNote = detailContent.querySelector(".next-note");
    const heading = nextNote?.querySelector("strong")?.textContent?.trim() ?? "";
    const completeText = nextNote?.textContent?.trim() ?? "";
    const nextAction = completeText.replace(/^(?:Safe next action|Next action)\s*/u, "").trim()
      || "Review the exact fixture next action.";
    const label = primaryAction.textContent?.trim() || "Operational action";
    event.preventDefault();
    event.stopImmediatePropagation();
    announcer.textContent = "";
    requestAnimationFrame(() => {
      announcer.textContent = policy.operationalAnnouncement(label, nextAction, heading === "Safe next action");
    });
  }, { capture: true });

  new MutationObserver(scheduleSync).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-scenario", "disabled"],
  });
  sync();
})();
