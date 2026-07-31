(() => {
  if (typeof document === "undefined") return;

  const identity = required("#canvas-identity");
  const inspectorTabsNode = required("#inspector-tabs");
  const inspectorContentNode = required("#inspector-content");

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

  syncHeadingIdentity();
  syncInspectorSemantics();
  new MutationObserver(syncHeadingIdentity).observe(identity, { childList: true });
  new MutationObserver(syncInspectorSemantics).observe(inspectorTabsNode, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });

  function required(selector) {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Studio Canvas workspace bridge is missing ${selector}`);
    return node;
  }
})();
