(() => {
  const ledger = document.querySelector("#ledger");
  const masthead = document.querySelector(".masthead");
  const atlas = document.querySelector(".atlas");
  const showLedger = document.querySelector("#show-ledger");
  if (!ledger || !masthead || !atlas || !showLedger) {
    throw new Error("Signal Atlas is missing its ledger focus boundary");
  }

  const hiddenDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden");
  if (!hiddenDescriptor?.get || !hiddenDescriptor.set || !hiddenDescriptor.configurable) {
    throw new Error("Signal Atlas requires the native HTMLElement.hidden accessor");
  }

  let returnTarget = showLedger;

  function isUsefulReturnTarget(value) {
    if (!(value instanceof HTMLElement) || value === document.body || !value.isConnected) return false;
    if (ledger.contains(value) || value.hidden || value.inert || value.hasAttribute("disabled")) return false;
    return value.tabIndex >= 0 || ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(value.tagName);
  }

  function repairReturnFocus() {
    if (isUsefulReturnTarget(document.activeElement)) return;
    const target = isUsefulReturnTarget(returnTarget) ? returnTarget : showLedger;
    target.focus();
  }

  Object.defineProperty(ledger, "hidden", {
    configurable: true,
    enumerable: hiddenDescriptor.enumerable,
    get() {
      return Reflect.apply(hiddenDescriptor.get, this, []);
    },
    set(value) {
      const hidden = Boolean(value);
      const wasHidden = Reflect.apply(hiddenDescriptor.get, this, []);
      if (!hidden && wasHidden) {
        returnTarget = isUsefulReturnTarget(document.activeElement) ? document.activeElement : showLedger;
      }
      masthead.inert = !hidden;
      atlas.inert = !hidden;
      Reflect.apply(hiddenDescriptor.set, this, [hidden]);
      if (hidden && !wasHidden) queueMicrotask(repairReturnFocus);
    },
  });

  ledger.setAttribute("role", "dialog");
  ledger.setAttribute("aria-modal", "true");
  ledger.hidden = ledger.hidden;
})();
