import { installRootModeStatus } from "./root-mode-status.js";

const root = document.documentElement;
const status = document.querySelector("#root-connecting-status");

try {
  if (root && status) {
    installRootModeStatus({ root, status });
  }
} catch {
  status?.setAttribute("aria-busy", "false");
  status?.setAttribute("aria-hidden", "true");
}
