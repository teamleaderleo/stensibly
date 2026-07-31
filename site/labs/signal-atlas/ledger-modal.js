(() => {
  const ledger = document.querySelector("#ledger");
  const masthead = document.querySelector(".masthead");
  const atlas = document.querySelector(".atlas");
  if (!ledger || !masthead || !atlas) throw new Error("Signal Atlas is missing its ledger focus boundary");

  const hiddenDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden");
  if (!hiddenDescriptor?.get || !hiddenDescriptor.set || !hiddenDescriptor.configurable) {
    throw new Error("Signal Atlas requires the native HTMLElement.hidden accessor");
  }

  Object.defineProperty(ledger, "hidden", {
    configurable: true,
    enumerable: hiddenDescriptor.enumerable,
    get() {
      return Reflect.apply(hiddenDescriptor.get, this, []);
    },
    set(value) {
      const hidden = Boolean(value);
      masthead.inert = !hidden;
      atlas.inert = !hidden;
      Reflect.apply(hiddenDescriptor.set, this, [hidden]);
    },
  });

  ledger.setAttribute("role", "dialog");
  ledger.setAttribute("aria-modal", "true");
  ledger.hidden = ledger.hidden;
})();
