const rootModes = new Set([
  "signed-out",
  "connecting",
  "connected",
  "degraded",
  "editing",
]);

export function applyRootModeStatus(status, mode) {
  if (!status || typeof status.setAttribute !== "function" || !status.dataset) {
    throw new TypeError("A root connecting status element is required.");
  }
  const normalizedMode = rootModes.has(mode) ? mode : "signed-out";
  const active = normalizedMode === "connecting";
  status.dataset.active = active ? "true" : "false";
  status.setAttribute("aria-busy", active ? "true" : "false");
  status.setAttribute("aria-hidden", active ? "false" : "true");
  return active;
}

export function installRootModeStatus({
  root,
  status,
  MutationObserverImpl = globalThis.MutationObserver,
}) {
  if (!root || !root.dataset) {
    throw new TypeError("A root document element is required.");
  }
  applyRootModeStatus(status, root.dataset.appMode);
  if (typeof MutationObserverImpl !== "function") {
    return Object.freeze({ disconnect() {} });
  }

  const observer = new MutationObserverImpl(() => {
    applyRootModeStatus(status, root.dataset.appMode);
  });
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["data-app-mode"],
  });
  return observer;
}
