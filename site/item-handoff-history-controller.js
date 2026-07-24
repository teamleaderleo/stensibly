import { handoffEventLabel } from './item-handoff.js';

export function installHandoffHistoryController() {
  const body = document.querySelector('#item-detail-body');
  if (!body) return null;

  let renderQueued = false;
  const observer = new MutationObserver(() => scheduleRender());
  observer.observe(body, { childList: true, subtree: true });
  scheduleRender();

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    for (const label of body.querySelectorAll('.detail-event-head strong')) {
      if (label.textContent?.trim() !== 'work.handed_off') continue;
      label.textContent = handoffEventLabel('work.handed_off');
    }
  }

  return {
    reset: scheduleRender,
    destroy() {
      observer.disconnect();
    },
  };
}

if (typeof document !== 'undefined') installHandoffHistoryController();
