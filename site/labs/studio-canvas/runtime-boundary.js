(() => {
  if (typeof globalThis.required !== "function") {
    throw new Error("Studio Canvas app did not publish its required-element boundary");
  }
  Object.defineProperty(globalThis, "requiredNode", {
    value: globalThis.required,
    writable: false,
    enumerable: false,
    configurable: false,
  });
})();
