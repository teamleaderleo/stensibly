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
          previewState: "degraded",
          previewDetail: "Fictional degraded preview: issue reads current, review threads delayed.",
        });
      }));
    },
    primaryActionLabel(action) {
      if (typeof action !== "string" || !action.trim()) throw new TypeError("Soft Companion action must be text");
      return `Preview: ${action.trim().replace(/^Preview:\s*/u, "")}`;
    },
    primaryActionAnnouncement(nextAction, safeRecovery = false) {
      if (typeof nextAction !== "string" || !nextAction.trim()) {
        throw new TypeError("Soft Companion action must include a next action");
      }
      const prefix = safeRecovery ? "Safe recovery preview" : "Fixture-only preview";
      return `${prefix}: ${nextAction.trim()}. No product action was performed.`;
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

  const fixture = globalThis.StensiblyFrontendLabFixtures?.frontendLabFixture;
  const connectionShelf = document.querySelector("#connection-shelf");
  const detailContent = document.querySelector("#detail-content");
  if (fixture && (connectionShelf || detailContent)) {
    let connectionRepairScheduled = false;
    const repairConnections = () => {
      connectionRepairScheduled = false;
      const projections = policy.projectConnections(fixture.connections, document.body.dataset.scenario ?? "default");
      repairConnectionShelf(projections);
      repairConnectionDetail(projections);
    };
    const scheduleConnectionRepair = () => {
      if (connectionRepairScheduled) return;
      connectionRepairScheduled = true;
      queueMicrotask(repairConnections);
    };

    if (connectionShelf) {
      new MutationObserver(scheduleConnectionRepair).observe(connectionShelf, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    if (detailContent) {
      new MutationObserver(scheduleConnectionRepair).observe(detailContent, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    new MutationObserver(scheduleConnectionRepair).observe(document.body, {
      attributes: true,
      attributeFilter: ["data-scenario"],
    });
    scheduleConnectionRepair();

    function repairConnectionShelf(projections) {
      if (!connectionShelf) return;
      const chips = [...connectionShelf.querySelectorAll(".connection-chip")];
      projections.forEach((connection, index) => {
        const chip = chips[index];
        if (!chip) return;
        const previewSuffix = connection.previewState ? ` · ${connection.previewState} preview` : "";
        const label = `${connection.label} · ${connection.state}${previewSuffix}`;
        if (chip.textContent !== label) chip.textContent = label;
        chip.dataset.state = connection.state;
        if (connection.previewState) chip.dataset.previewState = connection.previewState;
        else delete chip.dataset.previewState;
        chip.dataset.symbol = connection.state === "healthy" ? "✓" : connection.state === "offline" ? "×" : "△";
        chip.title = connection.previewDetail ?? connection.detail;
      });
      const ariaLabel = `Connection health: ${projections.map((connection) => {
        const previewSuffix = connection.previewState ? `, ${connection.previewState} preview` : "";
        return `${connection.label} ${connection.state}${previewSuffix}`;
      }).join(", ")}`;
      if (connectionShelf.getAttribute("aria-label") !== ariaLabel) connectionShelf.setAttribute("aria-label", ariaLabel);
    }

    function repairConnectionDetail(projections) {
      if (!detailContent) return;
      const section = [...detailContent.querySelectorAll(".detail-section")]
        .find((candidate) => candidate.querySelector("h3")?.textContent === "Connection health");
      const items = section ? [...section.querySelectorAll(".evidence-list > li")] : [];
      projections.forEach((connection, index) => {
        const item = items[index];
        if (!item) return;
        const label = item.querySelector("span:first-child");
        const state = item.querySelector("code");
        const detail = item.querySelector("span:last-child");
        const detailText = connection.previewState
          ? `${connection.previewState} preview · ${connection.previewDetail}`
          : connection.detail;
        if (label && label.textContent !== connection.label) label.textContent = connection.label;
        if (state && state.textContent !== connection.state) state.textContent = connection.state;
        if (detail && detail.textContent !== detailText) detail.textContent = detailText;
        if (connection.previewState) item.dataset.previewState = connection.previewState;
        else delete item.dataset.previewState;
      });
    }
  }

  const primaryAction = document.querySelector("#primary-action");
  const announcer = document.querySelector("#announcer");
  if (primaryAction && detailContent && announcer) {
    let actionRepairScheduled = false;
    const repairPrimaryLabel = () => {
      actionRepairScheduled = false;
      if (primaryAction.disabled || !primaryAction.textContent?.trim()) return;
      const label = policy.primaryActionLabel(primaryAction.textContent);
      if (primaryAction.textContent !== label) primaryAction.textContent = label;
    };
    const scheduleActionRepair = () => {
      if (actionRepairScheduled) return;
      actionRepairScheduled = true;
      queueMicrotask(repairPrimaryLabel);
    };
    new MutationObserver(scheduleActionRepair).observe(primaryAction, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    primaryAction.addEventListener("click", (event) => {
      if (primaryAction.disabled) return;
      const nextNote = detailContent.querySelector(".next-note");
      const heading = nextNote?.querySelector("strong")?.textContent?.trim() ?? "";
      const completeText = nextNote?.textContent?.trim() ?? "";
      const nextAction = completeText.replace(/^(?:Safe next action|Next action)\s*/u, "").trim()
        || "Review the exact fixture next action";
      event.preventDefault();
      event.stopImmediatePropagation();
      announcer.textContent = policy.primaryActionAnnouncement(nextAction, heading === "Safe next action");
    }, { capture: true });
    scheduleActionRepair();
  }
})();
