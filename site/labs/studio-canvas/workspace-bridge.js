(() => {
  const identity = document.querySelector("#canvas-identity");
  const inspectorTabs = document.querySelector("#inspector-tabs");
  const inspectorContent = document.querySelector("#inspector-content");
  if (!identity || !inspectorTabs || !inspectorContent) {
    throw new Error("Studio Canvas is missing its workspace bridge boundary");
  }

  const syncHeadingIdentity = () => {
    const heading = identity.querySelector("strong");
    if (heading) heading.id = "canvas-region-title";
  };

  const inspectorButtons = () => [...inspectorTabs.querySelectorAll('button[role="tab"]')];

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
    inspectorContent.setAttribute("role", "tabpanel");
    inspectorContent.tabIndex = 0;
    if (selected) inspectorContent.setAttribute("aria-labelledby", selected.id);
    else inspectorContent.removeAttribute("aria-labelledby");
  };

  syncHeadingIdentity();
  syncInspectorSemantics();
  new MutationObserver(syncHeadingIdentity).observe(identity, { childList: true });
  new MutationObserver(syncInspectorSemantics).observe(inspectorTabs, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });

  inspectorTabs.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    const current = event.target.closest('button[role="tab"]');
    if (!current || !inspectorTabs.contains(current)) return;
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
      const entry = selectedArtifact();
      if (button.dataset.localAction === "source") {
        announce(`Source summary: ${entry.source}. ${entry.revision}. Fictional local fixture only.`);
      } else {
        announce(`Next action: ${entry.nextAction}. No save, approval, submission, or write occurred.`);
      }
    });
  });
})();
