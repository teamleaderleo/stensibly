(() => {
  const replaceStateDescriptor = Object.getOwnPropertyDescriptor(History.prototype, "replaceState");
  if (!replaceStateDescriptor || typeof replaceStateDescriptor.value !== "function" || !replaceStateDescriptor.writable) {
    throw new Error("Field Console requires a writable History.replaceState method");
  }

  const nativeReplaceState = replaceStateDescriptor.value;
  Object.defineProperty(History.prototype, "replaceState", {
    ...replaceStateDescriptor,
    value(...args) {
      try {
        return Reflect.apply(nativeReplaceState, this, args);
      } catch (error) {
        if (error instanceof DOMException && error.name === "SecurityError") return undefined;
        throw error;
      }
    },
  });

  const timeline = document.querySelector("#timeline-list");
  if (!timeline) throw new Error("Field Console is missing #timeline-list");

  timeline.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const activated = event.target.closest("li[data-record-id] button");
    if (!activated || !timeline.contains(activated)) return;
    const recordId = activated.closest("li[data-record-id]")?.dataset.recordId;
    if (!recordId) return;
    requestAnimationFrame(() => {
      const replacement = [...timeline.querySelectorAll("li[data-record-id]")]
        .find((item) => item.dataset.recordId === recordId)
        ?.querySelector("button");
      replacement?.focus();
    });
  }, { capture: true });
})();
