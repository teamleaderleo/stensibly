(() => {
  const allowedScenarios = new Set(["default", "empty", "degraded"]);
  const requestedScenario = new URLSearchParams(location.search).get("scenario") ?? "default";
  const scenario = allowedScenarios.has(requestedScenario) ? requestedScenario : "default";
  document.body.dataset.scenario = scenario;

  if (scenario === "default") return;

  requestAnimationFrame(() => {
    if (scenario === "empty") {
      const unhealthyFilter = document.querySelector('button[data-filter="unhealthy"]');
      if (!(unhealthyFilter instanceof HTMLButtonElement)) {
        throw new Error("Quiet Control empty scenario requires the unhealthy filter");
      }
      unhealthyFilter.click();
      return;
    }

    const recoverView = document.querySelector('button[data-view="recover"]');
    if (!(recoverView instanceof HTMLButtonElement)) {
      throw new Error("Quiet Control degraded scenario requires the recover view");
    }
    recoverView.click();
    requestAnimationFrame(() => {
      const degradedRecord = document.querySelector('[data-record-id="sync-violet"]');
      if (!(degradedRecord instanceof HTMLButtonElement)) {
        throw new Error("Quiet Control degraded scenario requires the degraded fixture record");
      }
      degradedRecord.click();
    });
  });
})();
