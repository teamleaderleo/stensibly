import { installRootModeStatus } from "./root-mode-status.js";

const root = document.documentElement;
const status = document.querySelector("#root-connecting-status");
const advancedConnection = document.querySelector(".advanced-connection");
const changeConnection = document.querySelector("#change-connection");
const cancelConnection = document.querySelector("#cancel-connection");

try {
  if (root && status) {
    installRootModeStatus({ root, status });
  }
} catch {
  status?.setAttribute("aria-busy", "false");
  status?.setAttribute("aria-hidden", "true");
}

function setAdvancedConnectionOpen(open) {
  if (advancedConnection instanceof HTMLDetailsElement) {
    advancedConnection.open = open;
  }
}

changeConnection?.addEventListener("click", () => {
  setAdvancedConnectionOpen(true);
});

cancelConnection?.addEventListener("click", () => {
  setAdvancedConnectionOpen(false);
});

try {
  if (root && typeof globalThis.MutationObserver === "function") {
    const syncAdvancedConnection = () => {
      if (root.dataset.appMode === "editing") {
        setAdvancedConnectionOpen(true);
      } else if (
        root.dataset.appMode === "connected"
        || root.dataset.appMode === "degraded"
      ) {
        setAdvancedConnectionOpen(false);
      }
    };
    const observer = new globalThis.MutationObserver(syncAdvancedConnection);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-app-mode"],
    });
    syncAdvancedConnection();
  }
} catch {
  // The direct change/cancel controls remain usable if mode observation fails.
}
