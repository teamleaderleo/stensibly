(() => {
  const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
  if (!fixtureApi) throw new Error("Soft Companion interaction bridge requires shared fixtures");

  const body = document.body;
  const connectionShelf = document.querySelector("#connection-shelf");
  const detailContent = document.querySelector("#detail-content");
  const detailHeading = document.querySelector("#detail-heading");
  const primaryAction = document.querySelector("#primary-action");
  const announcer = document.querySelector("#announcer");
  if (!connectionShelf || !detailContent || !detailHeading || !primaryAction || !announcer) {
    throw new Error("Soft Companion interaction bridge is missing its DOM boundary");
  }

  let framePending = false;

  const projectedConnections = () => fixtureApi.frontendLabFixture.connections.map((connection) => {
    if (body.dataset.scenario !== "degraded" || connection.id !== "github") return connection;
    return Object.freeze({
      ...connection,
      state: "degraded",
      detail: "Fictional degraded preview: issue reads current, review threads delayed.",
    });
  });

  const syncConnections = () => {
    const connections = projectedConnections();
    const chips = [...connectionShelf.children];
    for (const [index, connection] of connections.entries()) {
      const chip = chips[index];
      if (!(chip instanceof HTMLElement)) continue;
      const label = `${connection.label} · ${connection.state}`;
      if (chip.textContent !== label) chip.textContent = label;
      if (chip.dataset.state !== connection.state) chip.dataset.state = connection.state;
      const symbol = connection.state === "healthy" ? "✓" : connection.state === "offline" ? "×" : "△";
      if (chip.dataset.symbol !== symbol) chip.dataset.symbol = symbol;
      if (chip.title !== connection.detail) chip.title = connection.detail;
    }
    const summary = `Connection health: ${connections.map((connection) => `${connection.label} · ${connection.state}`).join(", ")}`;
    if (connectionShelf.getAttribute("aria-label") !== summary) connectionShelf.setAttribute("aria-label", summary);

    const connectionHeading = [...detailContent.querySelectorAll("h3")]
      .find((heading) => heading.textContent?.trim() === "Connection health");
    const section = connectionHeading?.closest("section");
    const rows = section ? [...section.querySelectorAll("li")] : [];
    for (const [index, connection] of connections.entries()) {
      const row = rows[index];
      if (!row) continue;
      const value = row.children[1];
      const detail = row.children[2];
      if (value && value.textContent !== connection.state) value.textContent = connection.state;
      if (detail && detail.textContent !== connection.detail) detail.textContent = connection.detail;
    }
  };

  const selectedTone = () => {
    const state = detailHeading.querySelector(".state-label[data-tone]");
    return state instanceof HTMLElement ? state.dataset.tone ?? null : null;
  };

  const syncPrimaryAction = () => {
    if (!(primaryAction instanceof HTMLButtonElement) || primaryAction.disabled) return;
    const tone = selectedTone();
    if (!tone || tone === "serious" || tone === "warning") return;
    if (primaryAction.textContent !== "Undo preview acknowledgement") {
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
    if (!(primaryAction instanceof HTMLButtonElement) || primaryAction.disabled) return;
    const tone = selectedTone();
    if (tone !== "serious" && tone !== "warning") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const label = primaryAction.textContent?.trim() || "Operational action";
    announcer.textContent = "";
    requestAnimationFrame(() => {
      announcer.textContent = `${label}: fixture-only preview. No product action occurred.`;
    });
  }, { capture: true });

  new MutationObserver(scheduleSync).observe(body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-scenario", "disabled"],
  });

  sync();
})();
