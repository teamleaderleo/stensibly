(() => {
  const mapNodes = document.querySelector("#map-nodes");
  if (!mapNodes) throw new Error("Signal Atlas is missing #map-nodes for focus restoration");

  mapNodes.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const activated = event.target.closest("button[data-record-id]");
    if (!activated || !mapNodes.contains(activated)) return;
    const recordId = activated.dataset.recordId;
    if (!recordId) return;

    requestAnimationFrame(() => {
      const replacement = [...mapNodes.querySelectorAll("button[data-record-id]")]
        .find((button) => button.dataset.recordId === recordId && !button.hidden);
      replacement?.focus();
    });
  }, { capture: true });
})();
