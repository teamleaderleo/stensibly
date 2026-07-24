import { describe, expect, test } from "bun:test";

const loader = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/board-filter-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/board-filter.js", import.meta.url)).text();
const declaration = await Bun.file(new URL("../site/board-filter.d.ts", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/board-filter.css", import.meta.url)).text();

describe("dashboard board filter integration", () => {
  test("loads as a no-network dashboard sidecar", () => {
    expect(loader).toContain("import './board-filter-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installBoardFilterController()");
    expect(controller).not.toContain("fetch(");
    expect(controller).not.toContain("sessionStorage");
    expect(controller).not.toContain("localStorage");
    expect(controller).not.toContain("authorization");
  });

  test("adds accessible bounded search, kind, status, and reset controls", () => {
    expect(controller).toContain("panel.setAttribute('aria-label', 'Board search and filters')");
    expect(controller).toContain("search.maxLength = 200");
    expect(controller).toContain("search.setAttribute('aria-controls', 'board')");
    expect(controller).toContain("kind.setAttribute('aria-controls', 'board')");
    expect(controller).toContain("status.setAttribute('aria-controls', 'board')");
    expect(controller).toContain("result.setAttribute('aria-live', 'polite')");
    expect(controller).toContain("clearButton.textContent = 'clear board filters'");
    expect(controller).toContain("event.key !== 'Escape'");
  });

  test("annotates existing card text instead of replacing board records", () => {
    expect(controller).toContain("card.querySelector('.card-top span')");
    expect(controller).toContain("identity.indexOf(' · ')");
    expect(controller).toContain("card.dataset.filterKind = kind");
    expect(controller).toContain("card.dataset.filterStatus = status");
    expect(controller).toContain("card.dataset.filterProject = project");
    expect(controller).toContain("text: card.textContent || ''");
    expect(controller).not.toContain("board.replaceChildren");
    expect(controller).not.toContain("innerHTML");
  });

  test("reapplies after polling without an observer loop", () => {
    expect(controller).toContain("boardObserver.observe(board, { childList: true, subtree: true })");
    expect(controller).toContain("if (applyQueued) return");
    expect(controller).toContain("queueMicrotask");
    expect(controller).toContain("if (count && count.textContent !== countText) count.textContent = countText");
    expect(controller).toContain("if (existing) return");
  });

  test("updates visible counts, status columns, and honest empty states", () => {
    expect(controller).toContain("column.hidden = !statusVisible");
    expect(controller).toContain("card.hidden = !matches");
    expect(controller).toContain("boardResultLabel(visible, total, filters)");
    expect(controller).toContain("boardEmptyMessage(visible, total, filters)");
    expect(controller).toContain("No matching items in this status.");
    expect(controller).toContain("clearButton.disabled = !active");
  });

  test("resets on disconnect and leaves item detail click behavior intact", () => {
    expect(controller).toContain("if (dashboard.hidden) resetFilters()");
    expect(controller).toContain("button.card[data-item-id]");
    expect(controller).not.toContain("addEventListener('click', (event)");
    expect(controller).not.toContain("preventDefault()");
    expect(controller).not.toContain("stopPropagation()");
  });

  test("rejects credential-shaped user queries without inspecting tokens", () => {
    expect(helper).toContain("Credential-shaped values are not valid board searches.");
    expect(controller).toContain("search.value = ''");
    expect(controller).toContain("showError");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
  });

  test("keeps types and responsive presentation aligned", () => {
    expect(declaration).toContain("interface BoardFilterState");
    expect(declaration).toContain("interface BoardFilterCard");
    expect(controller).toContain("/board-filter.css");
    expect(styles).toContain(".board-filter-panel");
    expect(styles).toContain(".board-filter-controls");
    expect(styles).toContain("@media (max-width: 560px)");
  });
});
