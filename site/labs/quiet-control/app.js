const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
if (!fixtureApi) throw new Error("Quiet Control requires the shared frontend labs fixture contract");

const { frontendLabFixture: fixture, frontendLabTasks: tasks } = fixtureApi;
const references = Object.fromEntries(fixture.references.map((reference) => [reference.kind, reference]));
const connectionSummary = fixture.connections.map((connection) => `${connection.label} ${connection.state}`).join(" · ");
const views = buildViews(fixture);

let currentView = "attention";
let currentFilter = "all";
let selectedIndex = 0;
let commandReturnFocus = null;

const navList = required("#nav-list");
const workList = required("#work-list");
const workspace = required("#workspace");
const detailPane = required("#detail-pane");
const detailTitle = required("#detail-title");
const detailContent = required("#detail-content");
const announcer = required("#announcer");
const dialog = required("#command-dialog");
const commandInput = required("#command-input");
const commands = required("#commands");
const commandButton = required("#command-button");
const primaryAction = required("#primary-action");
const connectionHealth = required("#connection-health");
const filterButtons = [...document.querySelectorAll("[data-filter]")];

connectionHealth.textContent = connectionSummary;
connectionHealth.setAttribute("aria-label", `Connection health: ${connectionSummary}`);
renderNav();
renderView();
renderCommands("");

commandButton.addEventListener("click", openCommands);
required("#mobile-back").addEventListener("click", closeDetail);
filterButtons.forEach((button) => button.addEventListener("click", () => selectFilter(button.dataset.filter)));
document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => announce(`${button.textContent}: fixture action only`));
});
primaryAction.addEventListener("click", () => {
  const row = selectedRow();
  if (row) announce(`Next action: ${row.next}`);
});
commandInput.addEventListener("input", () => renderCommands(commandInput.value));
commandInput.addEventListener("keydown", handleCommandInputKeydown);
commands.addEventListener("keydown", handleCommandListKeydown);
dialog.addEventListener("close", restoreCommandFocus);

document.addEventListener("keydown", (event) => {
  const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommands();
    return;
  }
  if (!editing && event.key === "/") {
    event.preventDefault();
    openCommands();
    return;
  }
  if (dialog.open) return;
  if (!editing && /^[1-4]$/.test(event.key)) {
    selectView(Object.keys(views)[Number(event.key) - 1], true);
    return;
  }
  if (!editing && ["j", "J", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    moveSelection(1);
    return;
  }
  if (!editing && ["k", "K", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    moveSelection(-1);
    return;
  }
  if (!editing && event.key === "Enter" && workList.contains(document.activeElement)) openDetail();
  if (event.key === "Escape" && workspace.dataset.mobileDetail === "true") closeDetail();
});

function buildViews(data) {
  const project = data.project.name;
  const revision = references.revision?.value ?? "fixture-revision";
  const source = references.issue?.label ?? "Fictional issue";
  const deployment = references.deployment?.value ?? "fixture-deployment";

  return {
    attention: {
      label: "Attention",
      icon: "!",
      description: "The one human decision that can move this fictional workspace forward.",
      rows: [{
        id: data.decision.id,
        semanticState: data.decision.state,
        status: "attention",
        badge: "needs decision",
        age: "human",
        title: data.decision.title,
        ref: `${project} · decision`,
        owner: "operator",
        reason: data.decision.detail,
        health: "Decision waiting",
        source,
        evidence: revision,
        next: "Review the concise wording, then approve it or return it for revision.",
        disposition: "Human decision required",
        actionLabel: "Review decision",
      }],
    },
    active: {
      label: "Active",
      icon: "▶",
      description: "Every active fictional worker, with lease health written in plain text.",
      rows: data.workers.map((worker) => ({
        id: worker.id,
        semanticState: worker.state,
        status: worker.state === "healthy" ? "active" : "recover",
        badge: worker.state === "healthy" ? "healthy lease" : "lease unhealthy",
        age: worker.state === "healthy" ? "active" : "12m overdue",
        title: worker.label,
        ref: `${project} · worker`,
        owner: worker.label,
        reason: worker.detail,
        health: worker.state === "healthy" ? "Lease healthy" : "Lease unhealthy · reassignment available",
        source,
        evidence: revision,
        next: worker.state === "healthy" ? "Open the current evidence and let the bounded review continue." : "Confirm the lease is expired, then recover or reassign the work.",
        disposition: worker.state === "healthy" ? "Active and healthy" : "Recovery eligible",
        actionLabel: worker.state === "healthy" ? "Open activity" : "Start recovery",
      })),
    },
    ready: {
      label: "Ready",
      icon: "→",
      description: "Ranked work with the exact reason the first item is recommended.",
      rows: data.readyWork.map((work) => ({
        id: work.id,
        semanticState: work.state,
        status: "ready",
        badge: work.rank === 1 ? "recommended" : "ready",
        age: `p${work.rank}`,
        title: work.title,
        ref: `${project} · ranked work`,
        owner: "unclaimed",
        reason: work.reason,
        health: work.rank === 1 ? "Highest shared leverage" : "Available after the first item",
        source,
        evidence: revision,
        next: work.rank === 1 ? "Repair the shared focus order, then repeat keyboard evidence across every variant." : "Take this after the shared focus repair has landed.",
        disposition: work.rank === 1 ? "Top recommendation" : "Ready to select",
        actionLabel: "Open next action",
      })),
    },
    recover: {
      label: "Recover",
      icon: "↺",
      description: "Ambiguous, degraded, and recovered operations with one safe next action each.",
      rows: data.operations.map((operation) => ({
        id: operation.id,
        semanticState: operation.state,
        status: operation.state === "recovered" ? "active" : "recover",
        badge: operation.state,
        age: operation.state === "ambiguous" ? "receipt missing" : operation.state === "degraded" ? "delayed" : "settled",
        title: operation.title,
        ref: `${project} · operation`,
        owner: "operator",
        reason: operation.detail,
        health: operation.state === "ambiguous" ? "Remote settlement unknown" : operation.state === "degraded" ? "Partial service available" : "Recovered without duplicate writes",
        source: operation.state === "ambiguous" ? deployment : source,
        evidence: revision,
        next: operation.action,
        disposition: operation.state === "ambiguous" ? "Reconcile before retry" : operation.state === "degraded" ? "Inspect delayed evidence" : "Recovery complete",
        actionLabel: operation.action,
      })),
    },
  };
}

function renderNav() {
  navList.replaceChildren(...Object.entries(views).map(([key, view], index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.view = key;
    button.setAttribute("aria-current", key === currentView ? "page" : "false");
    button.title = `${view.label} (${index + 1})`;

    const icon = textNode("span", view.icon);
    icon.setAttribute("aria-hidden", "true");
    const label = textNode("span", view.label);
    const count = textNode("span", String(view.rows.length));
    count.className = "count";

    button.append(icon, label, count);
    button.addEventListener("click", () => selectView(key));
    item.append(button);
    return item;
  }));
}

function selectView(key, focusList = false) {
  if (!views[key]) return;
  currentView = key;
  selectedIndex = 0;
  workspace.dataset.mobileDetail = "false";
  renderNav();
  renderView();
  if (focusList) workList.querySelector("[data-index]")?.focus();
  announce(`${views[key].label} view, ${visibleRows().length} visible items`);
}

function selectFilter(filter) {
  if (!["all", "action", "unhealthy"].includes(filter)) return;
  currentFilter = filter;
  selectedIndex = 0;
  filterButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === filter)));
  renderView();
  announce(`${filterLabels[filter]} filter, ${visibleRows().length} visible items`);
}

const filterLabels = { all: "All work", action: "Needs action", unhealthy: "Unhealthy" };

function visibleRows() {
  const rows = views[currentView].rows;
  if (currentFilter === "action") return rows.filter((row) => ["attention", "recover"].includes(row.status));
  if (currentFilter === "unhealthy") return rows.filter((row) => ["unhealthy", "ambiguous", "degraded", "offline", "reconnecting", "failed", "stale", "blocked"].includes(row.semanticState));
  return rows;
}

function renderView() {
  const view = views[currentView];
  required("#view-title").textContent = view.label;
  required("#view-description").textContent = view.description;
  const rows = visibleRows();
  selectedIndex = Math.min(selectedIndex, Math.max(0, rows.length - 1));
  workList.replaceChildren(...(rows.length ? rows.map(renderRow) : [emptyRow()]));
  renderDetail();
}

function emptyRow() {
  const item = document.createElement("li");
  item.className = "empty-state";
  item.textContent = `No ${filterLabels[currentFilter].toLowerCase()} items in ${views[currentView].label}. Choose another filter or view.`;
  return item;
}

function renderRow(row, index) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.index = String(index);
  button.dataset.recordId = row.id;
  button.setAttribute("aria-current", String(index === selectedIndex));
  button.setAttribute("aria-label", `${row.title}. ${row.badge}. ${row.health}`);

  const top = element("span", "row-top");
  const badge = element("span", `badge ${row.status}`);
  badge.textContent = row.badge;
  top.append(badge, textNode("span", row.age));

  const title = textNode("strong", row.title);
  const meta = element("span", "row-meta");
  meta.append(textNode("span", row.ref), textNode("span", row.owner));
  const reason = textNode("span", row.reason);
  reason.className = "row-reason";
  const evidence = element("span", "row-evidence");
  const evidenceLabel = document.createElement("span");
  evidenceLabel.append("Evidence ", textNode("code", row.evidence));
  evidence.append(evidenceLabel, textNode("span", row.health));

  button.append(top, title, meta, reason, evidence);
  button.addEventListener("click", () => {
    selectedIndex = index;
    renderSelection();
    openDetail();
  });
  item.append(button);
  return item;
}

function moveSelection(delta) {
  const rows = visibleRows();
  if (!rows.length) return;
  selectedIndex = (selectedIndex + delta + rows.length) % rows.length;
  renderSelection(true);
  announce(rows[selectedIndex].title);
}

function renderSelection(focus = false) {
  workList.querySelectorAll("[data-index]").forEach((button, index) => {
    button.setAttribute("aria-current", String(index === selectedIndex));
  });
  const selected = workList.querySelector(`[data-index="${selectedIndex}"]`);
  selected?.scrollIntoView({ block: "nearest" });
  if (focus) selected?.focus();
  renderDetail();
}

function selectedRow() {
  return visibleRows()[selectedIndex] ?? null;
}

function renderDetail() {
  const row = selectedRow();
  if (!row) {
    primaryAction.disabled = true;
    detailTitle.replaceChildren(textNode("h2", "No matching item"), textNode("p", "The current filter returned an empty state."));
    const recovery = section("Recover the view");
    recovery.append(textNode("p", `Choose All work or switch views. Your project context remains ${fixture.project.name}.`));
    detailContent.replaceChildren(recovery);
    return;
  }

  primaryAction.disabled = false;
  primaryAction.textContent = row.actionLabel;
  const badge = element("span", `badge ${row.status}`);
  badge.textContent = row.badge;
  const title = textNode("h2", row.title);
  const subtitle = textNode("p", `${row.ref} · owner ${row.owner}`);
  detailTitle.replaceChildren(badge, title, subtitle);

  const summary = element("section", "summary");
  summary.setAttribute("aria-label", "Current work summary");
  summary.append(summaryCard("Disposition", row.disposition), summaryCard("Health", row.health), summaryCard("Current source", row.source));

  const why = section("Why this is here");
  why.append(textNode("p", row.reason));
  const next = element("div", "next");
  next.append(textNode("strong", "Next action"), document.createElement("br"), row.next);
  why.append(next);

  const evidence = section("Evidence");
  const evidenceList = element("ul", "evidence");
  evidenceList.append(
    evidenceRow("revision", row.evidence, "current fixture"),
    evidenceRow("source", row.source, "invented"),
    evidenceRow("artifact", references.artifact?.value ?? "fixture-artifact", "public fixture"),
  );
  evidence.append(evidenceList);

  const connectionSection = section("Connection health");
  const connectionList = element("ul", "evidence");
  for (const connection of fixture.connections) connectionList.append(evidenceRow(connection.label, connection.state, connection.detail));
  connectionSection.append(connectionList);

  const activity = section("Activity");
  const activityList = element("ul", "evidence");
  activityList.append(activityRow(row.status, row.badge, row.reason, row.age), activityRow("ready", "next", row.next, "queued"));
  activity.append(activityList, technicalDetails(row));

  detailContent.replaceChildren(summary, why, evidence, connectionSection, activity);
}

function summaryCard(label, value) {
  const wrapper = document.createElement("div");
  wrapper.append(textNode("span", label), textNode("strong", value));
  return wrapper;
}

function section(title) {
  const wrapper = element("section", "section");
  wrapper.append(textNode("h3", title));
  return wrapper;
}

function evidenceRow(label, value, state) {
  const item = document.createElement("li");
  item.append(textNode("span", label), textNode("code", value), textNode("span", state));
  return item;
}

function activityRow(status, label, value, time) {
  const item = document.createElement("li");
  const badge = element("span", `badge ${status}`);
  badge.textContent = label;
  item.append(badge, textNode("code", value), textNode("time", time));
  return item;
}

function technicalDetails(row) {
  const details = document.createElement("details");
  details.append(textNode("summary", "Technical details"));
  const list = document.createElement("dl");
  for (const [label, value] of [
    ["Record", row.id],
    ["Evidence head", row.evidence],
    ["Projection", "quiet-control-shared-fixture/v1"],
    ["Authority", "display only"],
  ]) list.append(textNode("dt", label), textNode("dd", value));
  details.append(list);
  return details;
}

function openDetail() {
  if (!selectedRow()) return;
  workspace.dataset.mobileDetail = "true";
  detailPane.focus();
}

function closeDetail() {
  workspace.dataset.mobileDetail = "false";
  workList.querySelector(`[data-index="${selectedIndex}"]`)?.focus();
}

function openCommands() {
  if (dialog.open) {
    commandInput.focus();
    return;
  }
  commandReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : commandButton;
  commandInput.value = "";
  renderCommands("");
  dialog.showModal();
  commandInput.focus();
}

function restoreCommandFocus() {
  const target = commandReturnFocus?.isConnected ? commandReturnFocus : commandButton;
  commandReturnFocus = null;
  target.focus();
}

function commandOptions(query) {
  const normalized = query.trim().toLowerCase();
  return [
    ...Object.entries(views).map(([key, view], index) => ({ label: `Go to ${view.label}`, hint: String(index + 1), run: () => selectView(key, true) })),
    ...tasks.map((task) => ({ label: `Task: ${task.prompt}`, hint: task.id, run: () => selectTask(task) })),
    { label: "Open selected detail", hint: "Enter", run: openDetail },
    { label: "Announce connection health", hint: "C", run: () => announce(connectionSummary) },
  ].filter((option) => option.label.toLowerCase().includes(normalized));
}

function renderCommands(query) {
  const options = commandOptions(query);
  commands.replaceChildren(...options.map((option, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.commandIndex = String(index);
    button.append(textNode("span", option.label), textNode("small", option.hint));
    button.addEventListener("click", () => runCommand(option));
    item.append(button);
    return item;
  }));
}

function selectTask(task) {
  const successIds = task.success.split(",");
  if (successIds.every((id) => fixture.connections.some((connection) => connection.id === id))) {
    connectionHealth.focus();
    announce(`${task.prompt} ${connectionSummary}`);
    return;
  }
  const location = findRowLocation(successIds[0]);
  if (!location) return;
  currentFilter = "all";
  filterButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === "all")));
  currentView = location.view;
  selectedIndex = location.index;
  workspace.dataset.mobileDetail = "false";
  renderNav();
  renderView();
  renderSelection(true);
  announce(`${task.prompt} Target selected: ${successIds.join(", ")}`);
}

function findRowLocation(id) {
  for (const [view, definition] of Object.entries(views)) {
    const index = definition.rows.findIndex((row) => row.id === id);
    if (index >= 0) return { view, index };
  }
  if (fixture.connections.some((connection) => connection.id === id)) return { view: "attention", index: 0 };
  return null;
}

function runCommand(option) {
  commandReturnFocus = null;
  dialog.close();
  requestAnimationFrame(option.run);
}

function handleCommandInputKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    commands.querySelector("button")?.focus();
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    [...commands.querySelectorAll("button")].at(-1)?.focus();
  }
  if (event.key === "Enter") {
    const first = commandOptions(commandInput.value)[0];
    if (first) {
      event.preventDefault();
      runCommand(first);
    }
  }
}

function handleCommandListKeydown(event) {
  const buttons = [...commands.querySelectorAll("button")];
  const index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
  }
}

function announce(message) {
  announcer.textContent = "";
  requestAnimationFrame(() => { announcer.textContent = message; });
}

function element(tagName, className) {
  const node = document.createElement(tagName);
  node.className = className;
  return node;
}

function textNode(tagName, value) {
  const node = document.createElement(tagName);
  node.textContent = value;
  return node;
}

function required(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Quiet Control is missing ${selector}`);
  return node;
}
