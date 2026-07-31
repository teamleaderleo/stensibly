(() => {
  const navList = document.querySelector("#nav-list");
  if (!navList) throw new Error("Quiet Control is missing #nav-list for focus restoration");

  navList.addEventListener("click", (event) => {
    if (event.detail !== 0 || !(event.target instanceof Element)) return;
    const activated = event.target.closest("button[data-view]");
    if (!activated || !navList.contains(activated)) return;
    const view = activated.dataset.view;
    if (!view) return;

    requestAnimationFrame(() => {
      const replacement = [...navList.querySelectorAll("button[data-view]")]
        .find((button) => button.dataset.view === view);
      replacement?.focus();
    });
  }, { capture: true });
})();
