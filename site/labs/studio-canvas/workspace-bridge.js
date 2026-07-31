(() => {
  const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
  if (!fixtureApi) throw new Error("Studio Canvas requires the shared frontend labs fixture contract");

  const expectedArtifactIds = Object.freeze([
    "approve-release-note",
    "worker-health",
    "repair-focus-order",
    "deploy-amber",
    "connection-health",
  ]);

  const policy = Object.freeze({
    projectArtifacts(baseArtifacts, fixture) {
      if (!Array.isArray(baseArtifacts)) throw new TypeError("Studio Canvas artifacts must be an array");
      const ids = baseArtifacts.map((entry) => {
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
          throw new TypeError("Studio Canvas artifacts require identities");
        }
        return entry.id;
      });
      if (new Set(ids).size !== ids.length) throw new TypeError("Studio Canvas artifact identities must be unique");
      if (ids.join(",") !== expectedArtifactIds.join(",")) {
        throw new TypeError("Studio Canvas artifacts must match the exact shared task order");
      }
      if (!fixture || typeof fixture !== "object") throw new TypeError("Studio Canvas fixture is missing");

      const decision = requiredRecord(fixture.decision, "decision");
      const workers = requiredRecordArray(fixture.workers, "workers", 2);
      const ready = requiredRecordArray(fixture.readyWork, "ready work", 1)
        .find((entry) => entry.id === "repair-focus-order");
      const operation = requiredRecordArray(fixture.operations, "operations", 1)
        .find((entry) => entry.id === "deploy-amber");
      const connections = requiredRecordArray(fixture.connections, "connections", 3);
      if (decision.id !== "approve-release-note" || !ready || !operation) {
        throw new TypeError("Studio Canvas fixture identities are incomplete");
      }

      return Object.freeze(baseArtifacts.map((base) => {
        if (base.id === "approve-release-note") {
          return freezeArtifact({
            ...base,
            title: decision.title,
            summary: decision.detail,
            source: `Shared decision ${decision.id}`,
            sections: [
              ["Decision", decision.detail],
              ["Decision requested", base.sections[1]?.[1] ?? base.nextAction],
              ["Publication boundary", base.sections[2]?.[1] ?? "Fixture-only preview."],
            ],
            evidence: [decision.id, ...base.evidence],
          });
        }
        if (base.id === "worker-health") {
          return freezeArtifact({
            ...base,
            summary: workers.map((entry) => `${entry.label} ${entry.state}: ${entry.detail}`).join(" "),
            source: "Shared worker projection",
            sections: [
              ...workers.map((entry) => [entry.label, `${entry.state}. ${entry.detail}`]),
              ["Interpretation", base.sections.at(-1)?.[1] ?? "Worker and lease state remain separate facts."],
            ],
            evidence: workers.map((entry) => entry.id),
          });
        }
        if (base.id === "repair-focus-order") {
          return freezeArtifact({
            ...base,
            title: `Plan: ${ready.title}`,
            summary: ready.reason,
            source: `Shared ready work rank ${ready.rank}`,
            evidence: [ready.id, ...base.evidence],
          });
        }
        if (base.id === "deploy-amber") {
          return freezeArtifact({
            ...base,
            title: operation.title,
            summary: operation.detail,
            source: `Shared operation ${operation.id}`,
            nextAction: operation.action,
            sections: [
              ["Observed", operation.detail],
              ["Unknown", base.sections[1]?.[1] ?? "Remote settlement remains unknown."],
              ["Safe action", operation.action],
            ],
            evidence: [operation.id, ...base.evidence],
          });
        }
        return freezeArtifact({
          ...base,
          summary: connections.map((entry) => `${entry.label} ${entry.state}: ${entry.detail}`).join(" "),
          source: "Shared connection projection",
          sections: connections.map((entry) => [entry.label, `${entry.state}. ${entry.detail}`]),
          evidence: connections.map((entry) => entry.id),
        });
      }));
    },

    commandKinds(narrow) {
      return Object.freeze(narrow
        ? ["artifact", "inspector", "compare"]
        : ["artifact", "inspector", "compare", "collapse-work", "collapse-inspector"]);
    },

    localActionCopy(entry, action) {
      if (!entry || typeof entry !== "object") throw new TypeError("Studio Canvas selected artifact is missing");
      if (action === "source") {
        return `Source summary: ${entry.source}. Revision ${entry.revision}. Fictional local fixture only.`;
      }
      if (action === "next") {
        return `Next action: ${entry.nextAction}. No save, approval, submission, or write occurred.`;
      }
      throw new TypeError("Studio Canvas local action is unsupported");
    },

    usefulReturnTarget(value, body, dialog) {
      if (!value || typeof value !== "object" || value === body) return false;
      if (value.isConnected !== true || value.hidden === true || value.inert === true) return false;
      if (typeof dialog?.contains === "function" && dialog.contains(value)) return false;
      if (typeof value.hasAttribute === "function" && value.hasAttribute("disabled")) return false;
      const tagName = typeof value.tagName === "string" ? value.tagName : "";
      return Number.isInteger(value.tabIndex) && value.tabIndex >= 0
        || ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(tagName);
    },
  });

  Object.defineProperty(globalThis, "StensiblyStudioCanvasPolicy", {
    value: policy,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  if (typeof document === "undefined") return;

  const identity = requiredNode("#canvas-identity");
  const inspectorTabsNode = requiredNode("#inspector-tabs");
  const inspectorContentNode = requiredNode("#inspector-content");
  const commandDialogNode = requiredNode("#command-dialog");
  const commandInputNode = requiredNode("#command-input");
  const commandListNode = requiredNode("#command-list");
  const commandTriggerNode = requiredNode("#command-trigger");
  const localResult = requiredNode("#local-action-result");
  const body = document.body;
  const narrowMedia = matchMedia("(max-width: 48rem)");
  const projectedArtifacts = policy.projectArtifacts(artifacts, fixtureApi.frontendLabFixture);
  const nativeSetCollapsed = setCollapsed;

  selectedArtifact = function selectedSharedArtifact() {
    const entry = projectedArtifacts[selectedArtifactIndex];
    if (!entry) throw new Error("Studio Canvas selected artifact is missing");
    return entry;
  };

  renderWorkList = function renderSharedWorkList() {
    workList.replaceChildren(...projectedArtifacts.map((entry, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.artifactId = entry.id;
      button.setAttribute("aria-current", String(index === selectedArtifactIndex));
      button.setAttribute("aria-label", `${entry.title}. ${entry.state}. ${entry.summary}`);
      const top = element("span", "work-row-top");
      top.append(text("span", entry.kind, "eyebrow"), stateChip(entry.state));
      button.append(top, text("strong", entry.title), text("span", entry.summary, "work-summary"));
      button.addEventListener("click", () => selectArtifact(index, false));
      item.append(button);
      return item;
    }));
  };

  selectArtifact = function selectSharedArtifact(index, focus) {
    selectedArtifactIndex = (index + projectedArtifacts.length) % projectedArtifacts.length;
    compareVersionId = null;
    hideLocalResult();
    renderWorkspace();
    if (focus) workList.querySelector(`[data-artifact-id="${selectedArtifact().id}"]`)?.focus();
    announce(`${selectedArtifact().title}. ${selectedArtifact().state}.`);
  };

  setCollapsed = function setResponsiveCollapse(region, collapsed) {
    if (narrowMedia.matches) {
      clearCollapsedState();
      announce("Collapse controls are disabled in the narrow stacked layout.");
      return;
    }
    nativeSetCollapsed(region, collapsed);
  };

  openCommands = function openValidatedCommands() {
    if (commandDialogNode.open) return;
    commandReturnFocus = isUsefulReturnTarget(document.activeElement)
      ? document.activeElement
      : commandTriggerNode;
    commandInputNode.value = "";
    renderCommands("");
    commandDialogNode.showModal();
    commandInputNode.focus();
  };

  renderCommands = function renderFocusedCommands(query) {
    const normalized = query.trim().toLowerCase();
    const commands = [
      ...projectedArtifacts.map((entry, index) => ({
        kind: "artifact",
        label: `Open ${entry.title}`,
        detail: entry.kind,
        run: () => selectArtifact(index, true),
      })),
      ...tabs.map((tab, index) => ({
        kind: "inspector",
        label: `Open ${capitalize(tab)} inspector`,
        detail: "context panel",
        run: () => selectTab(index, true),
      })),
      {
        kind: "compare",
        label: "Toggle revision comparison",
        detail: "local view only",
        run: toggleCompare,
      },
      ...narrowMedia.matches ? [] : [
        {
          kind: "collapse-work",
          label: "Collapse work region",
          detail: "recoverable layout",
          run: () => setCollapsed("work", true),
        },
        {
          kind: "collapse-inspector",
          label: "Collapse inspector region",
          detail: "recoverable layout",
          run: () => setCollapsed("inspector", true),
        },
      ],
    ].filter((entry) => `${entry.label} ${entry.detail}`.toLowerCase().includes(normalized));

    commandListNode.replaceChildren(...commands.map((entry) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.commandKind = entry.kind;
      button.append(document.createTextNode(entry.label), text("span", entry.detail));
      button.addEventListener("click", () => {
        commandReturnFocus = null;
        commandDialogNode.close();
        requestAnimationFrame(entry.run);
      });
      item.append(button);
      return item;
    }));
  };

  const syncHeadingIdentity = () => {
    const heading = identity.querySelector("strong");
    if (heading) heading.id = "canvas-region-title";
  };

  const inspectorButtons = () => [...inspectorTabsNode.querySelectorAll('button[role="tab"]')];

  const syncInspectorSemantics = () => {
    const buttons = inspectorButtons();
    let selected = null;
    for (const button of buttons) {
      const tab = button.dataset.tab;
      if (!tab) continue;
      button.id = `studio-canvas-tab-${tab}`;
      button.setAttribute("aria-controls", "inspector-content");
      const active = button.getAttribute("aria-selected") === "true";
      button.tabIndex = active ? 0 : -1;
      if (active) selected = button;
    }
    inspectorContentNode.setAttribute("role", "tabpanel");
    inspectorContentNode.tabIndex = 0;
    if (selected) inspectorContentNode.setAttribute("aria-labelledby", selected.id);
    else inspectorContentNode.removeAttribute("aria-labelledby");
  };

  inspectorTabsNode.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    const current = event.target.closest('button[role="tab"]');
    if (!current || !inspectorTabsNode.contains(current)) return;
    const buttons = inspectorButtons();
    const currentIndex = buttons.indexOf(current);
    if (currentIndex < 0) return;

    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % buttons.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = buttons.length - 1;
    if (nextIndex === null) return;

    const nextTab = buttons[nextIndex]?.dataset.tab;
    if (!nextTab) return;
    event.preventDefault();
    event.stopPropagation();
    buttons[nextIndex]?.click();
    requestAnimationFrame(() => {
      inspectorButtons().find((button) => button.dataset.tab === nextTab)?.focus();
    });
  });

  document.querySelectorAll("[data-local-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const message = policy.localActionCopy(selectedArtifact(), button.dataset.localAction);
      localResult.textContent = message;
      localResult.hidden = false;
      localResult.focus({ preventScroll: true });
      announce(message);
    });
  });

  commandDialogNode.addEventListener("close", () => {
    if (!commandReturnFocus) return;
    const target = isUsefulReturnTarget(commandReturnFocus) ? commandReturnFocus : commandTriggerNode;
    if (document.activeElement !== target) target.focus();
  });

  function isUsefulReturnTarget(value) {
    return value instanceof HTMLElement
      && policy.usefulReturnTarget(value, body, commandDialogNode);
  }

  function clearCollapsedState() {
    body.dataset.workCollapsed = "false";
    body.dataset.inspectorCollapsed = "false";
  }

  function syncNarrowContract() {
    if (narrowMedia.matches) clearCollapsedState();
    renderCommands(commandInputNode.value);
  }

  function hideLocalResult() {
    localResult.hidden = true;
    localResult.textContent = "";
  }

  syncHeadingIdentity();
  syncInspectorSemantics();
  new MutationObserver(syncHeadingIdentity).observe(identity, { childList: true });
  new MutationObserver(syncInspectorSemantics).observe(inspectorTabsNode, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });
  narrowMedia.addEventListener?.("change", syncNarrowContract);

  clearCollapsedState();
  renderWorkList();
  renderWorkspace();
  renderCommands("");
  syncNarrowContract();

  function requiredRecord(value, label) {
    if (!value || typeof value !== "object" || typeof value.id !== "string") {
      throw new TypeError(`Studio Canvas shared ${label} is missing`);
    }
    return value;
  }

  function requiredRecordArray(value, label, minimum) {
    if (!Array.isArray(value) || value.length < minimum) {
      throw new TypeError(`Studio Canvas shared ${label} are incomplete`);
    }
    return value.map((entry, index) => requiredRecord(entry, `${label} ${index + 1}`));
  }

  function freezeArtifact(value) {
    return Object.freeze({
      ...value,
      sections: Object.freeze(value.sections.map((entry) => Object.freeze([...entry]))),
      evidence: Object.freeze([...value.evidence]),
      comments: Object.freeze([...value.comments]),
      versions: Object.freeze([...value.versions]),
      activity: Object.freeze([...value.activity]),
    });
  }
})();
