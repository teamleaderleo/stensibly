const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
if (!fixtureApi) throw new Error("Soft Companion requires the shared frontend labs fixture contract");

const { frontendLabFixture: fixture, frontendLabTasks: tasks } = fixtureApi;
const references = Object.fromEntries(fixture.references.map((reference) => [reference.kind, reference]));
const modes = buildModes();
const taskTargets = Object.freeze({
  "human-decision": { mode: "today", identity: "approve-release-note" },
  "worker-health": { mode: "workers", identity: "ember" },
  "recommended-work": { mode: "ready", identity: "repair-focus-order" },
  "safe-reconciliation": { mode: "recover", identity: "deploy-amber" },
});
const supportedScenarios = new Set(["default", "empty", "loading", "degraded", "error"]);

let currentMode = "today";
let currentFilter = "all";
let selectedIndex = 0;
let dialogReturnFocus = null;
let acknowledgedId = null;

const body = document.body;
const roomGrid = required(".room-grid");
const modeList = required("#mode-list");
const workList = required("#work-list");
const workDetail = required("#work-detail");
const detailHeading = required("#detail-heading");
const detailContent = required("#detail-content");
const companion = required("#companion");
const companionMessage = required("#companion-message");
const companionDetail = required("#companion-detail");
const connectionShelf = required("#connection-shelf");
const resultSummary = required("#result-summary");
const scenarioSelect = required("#scenario-select");
const filterButtons = [...document.querySelectorAll("[data-filter]")];
const commandTrigger = required("#command-trigger");
const commandDialog = required("#command-dialog");
const commandClose = required("#command-close");
const commandInput = required("#command-input");
const commandList = required("#command-list");
const primaryAction = required("#primary-action");
const secondaryAction = required("#secondary-action");
const announcer = required("#announcer");

required("#project-name").textContent = fixture.project.name;
scenarioSelect.value = initialScenario();
applyScenario(scenarioSelect.value, false);
renderModes();
renderConnections();
renderView();
renderCommands("");

scenarioSelect.addEventListener("change", () => applyScenario(scenarioSelect.value, true));
filterButtons.forEach((button) => button.addEventListener("click", () => selectFilter(button.dataset.filter)));
required("#back-button").addEventListener("click", closeDetail);
commandTrigger.addEventListener("click", openCommands);
commandClose.addEventListener("click", () => commandDialog.close());
commandInput.addEventListener("input", () => renderCommands(commandInput.value));
commandInput.addEventListener("keydown", handleCommandInputKeydown);
commandList.addEventListener("keydown", handleCommandListKeydown);
commandDialog.addEventListener("close", restoreDialogFocus);
primaryAction.addEventListener("click", runPrimaryAction);
secondaryAction.addEventListener("click", () => {
  const row = selectedRow();
  if (row) announce(`Fixture evidence: ${row.evidence}, ${row.source}`);
});

document.addEventListener("keydown", (event) => {
  const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
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
  if (commandDialog.open) return;
  if (!editing && /^[1-4]$/.test(event.key)) {
    selectMode(Object.keys(modes)[Number(event.key) - 1], true);
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
  if (event.key === "Escape" && roomGrid.dataset.mobileDetail === "true") closeDetail();
});

function buildModes() {
  const project = fixture.project.name;
  const revision = references.revision?.value ?? "fixture-revision";
  const source = references.issue?.label ?? "Fictional issue";
  const deployment = references.deployment?.value ?? "fixture-deployment";

  const decision = {
    id: fixture.decision.id,
    semanticState: fixture.decision.state,
    tone: "serious",
    symbol: "!",
    stateLabel: "Human decision",
    title: fixture.decision.title,
    description: fixture.decision.detail,
    owner: "operator",
    context: `${project} · release note`,
    health: "Waiting for a bounded decision",
    disposition: "Needs your review",
    source,
    evidence: revision,
    next: "Read the concise wording, then approve it or return it for revision.",
    action: "Review wording",
  };

  const ready = fixture.readyWork.map((work) => ({
    id: work.id,
    semanticState: work.state,
    tone: "ready",
    symbol: work.rank === 1 ? "★" : "→",
    stateLabel: work.rank === 1 ? "Recommended" : "Ready",
    title: work.title,
    description: work.reason,
    owner: "unclaimed",
    context: `${project} · priority ${work.rank}`,
    health: work.rank === 1 ? "Highest shared leverage" : "Available after priority one",
    disposition: work.rank === 1 ? "Top recommendation" : "Ready to select",
    source,
    evidence: revision,
    next: work.rank === 1 ? "Repair shared focus order, then repeat keyboard evidence across every variant." : "Take this after the shared focus repair lands.",
    action: "Open next action",
  }));

  const workers = fixture.workers.map((worker) => ({
    id: worker.id,
    semanticState: worker.state,
    tone: worker.state === "healthy" ? "healthy" : "serious",
    symbol: worker.state === "healthy" ? "✓" : "!",
    stateLabel: worker.state === "healthy" ? "Healthy lease" : "Lease unhealthy",
    title: worker.label,
    description: worker.detail,
    owner: worker.label,
    context: `${project} · active worker`,
    health: worker.state === "healthy" ? "Lease healthy" : "Lease expired · reassignment available",
    disposition: worker.state === "healthy" ? "Active and healthy" : "Recovery eligible",
    source,
    evidence: revision,
    next: worker.state === "healthy" ? "Open the current evidence and let the bounded review continue." : "Confirm the lease expired, then recover or reassign the work.",
    action: worker.state === "healthy" ? "Open activity" : "Start recovery",
  }));

  const operations = fixture.operations.map((operation) => ({
    id: operation.id,
    semanticState: operation.state,
    tone: operation.state === "ambiguous" ? "serious" : operation.state === "degraded" ? "warning" : "recovered",
    symbol: operation.state === "ambiguous" ? "!" : operation.state === "degraded" ? "△" : "✓",
    stateLabel: operation.state === "ambiguous" ? "Ambiguous result" : operation.state,
    title: operation.title,
    description: operation.detail,
    owner: "operator",
    context: `${project} · operation`,
    health: operation.state === "ambiguous" ? "Remote settlement unknown" : operation.state === "degraded" ? "Partial service available" : "Recovered without duplicate writes",
    disposition: operation.state === "ambiguous" ? "Reconcile before retry" : operation.state === "degraded" ? "Inspect delayed evidence" : "Recovery complete",
    source: operation.state === "ambiguous" ? deployment : source,
    evidence: revision,
    next: operation.action,
    action: operation.action,
  }));

  return {
    today: { label: "Today", icon: "☀", eyebrow: "Today’s desk", title: "A gentle place for exact work.", description: "One decision and the highest-leverage ready item, with literal state beside every warm cue.", rows: [decision, ready[0]] },
    workers: { label: "Workers", icon: "♧", eyebrow: "Worker nook", title: "See every active worker and lease.", description: "Health is written in plain text, including the one expired lease and its safe recovery.", rows: workers },
    ready: { label: "Ready", icon: "✦", eyebrow: "Next-up tray", title: "Know what helps most next.", description: "Ranked work explains why the first item is recommended before you choose it.", rows: ready },
    recover: { label: "Recover", icon: "↺", eyebrow: "Repair basket", title: "Resolve uncertainty before retrying.", description: "Ambiguous, degraded, and recovered operations keep their exact next actions visible.", rows: operations },
  };
}

function initialScenario() {
  const value = new URLSearchParams(location.search).get("scenario") ?? "default";
  return supportedScenarios.has(value) ? value : "default";
}

function applyScenario(value, announceChange) {
  const scenario = supportedScenarios.has(value) ? value : "default";
  body.dataset.scenario = scenario;
  scenarioSelect.value = scenario;
  const url = new URL(location.href);
  if (scenario === "default") url.searchParams.delete("scenario");
  else url.searchParams.set("scenario", scenario);
  history.replaceState(null, "", url);
  renderConnections();
  renderView();
  if (announceChange) announce(`${scenario} preview state. Local fixture presentation only.`);
}

function renderModes() {
  modeList.replaceChildren(...Object.entries(modes).map(([key, mode], index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mode = key;
    button.setAttribute("aria-current", key === currentMode ? "page" : "false");
    button.title = `${mode.label} (${index + 1})`;
    const icon = text("span", mode.icon);
    icon.setAttribute("aria-hidden", "true");
    const label = text("span", mode.label);
    const count = text("span", String(mode.rows.length));
    count.className = "mode-count";
    button.append(icon, label, count);
    button.addEventListener("click", () => selectMode(key));
    item.append(button);
    return item;
  }));
}

function renderConnections() {
  const degraded = body.dataset.scenario === "degraded";
  connectionShelf.replaceChildren(...fixture.connections.map((connection) => {
    const state = degraded && connection.id === "github" ? "degraded" : connection.state;
    const chip = text("span", `${connection.label} · ${state}`);
    chip.className = "connection-chip";
    chip.dataset.state = state;
    chip.dataset.symbol = state === "healthy" ? "✓" : state === "offline" ? "×" : "△";
    chip.title = degraded && connection.id === "github" ? "Fictional degraded preview: issue reads current, review threads delayed." : connection.detail;
    return chip;
  }));
  connectionShelf.setAttribute("aria-label", `Connection health: ${[...connectionShelf.children].map((chip) => chip.textContent).join(", ")}`);
}

function selectMode(key, focusList = false) {
  if (!modes[key]) return;
  currentMode = key;
  currentFilter = "all";
  selectedIndex = 0;
  acknowledgedId = null;
  roomGrid.dataset.mobileDetail = "false";
  filterButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === "all")));
  renderModes();
  renderView();
  if (focusList) workList.querySelector("button")?.focus();
  announce(`${modes[key].label} drawer, ${visibleRows().length} visible cards`);
}

function selectFilter(filter) {
  if (!["all", "action", "unhealthy"].includes(filter)) return;
  currentFilter = filter;
  selectedIndex = 0;
  acknowledgedId = null;
  filterButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === filter)));
  renderView();
  announce(`${filterLabels[filter]} filter, ${visibleRows().length} visible cards`);
}

const filterLabels = { all: "All", action: "Needs action", unhealthy: "Unhealthy" };

function visibleRows() {
  const rows = modes[currentMode].rows;
  if (currentFilter === "action") return rows.filter((row) => row.tone === "serious" || row.tone === "warning");
  if (currentFilter === "unhealthy") return rows.filter((row) => ["unhealthy", "ambiguous", "degraded", "offline", "reconnecting", "failed", "blocked", "stale"].includes(row.semanticState));
  return rows;
}

function renderView() {
  const mode = modes[currentMode];
  required("#view-eyebrow").textContent = mode.eyebrow;
  required("#view-title").textContent = mode.title;
  required("#view-description").textContent = mode.description;
  const scenario = body.dataset.scenario;
  const rows = visibleRows();
  selectedIndex = Math.min(selectedIndex, Math.max(0, rows.length - 1));

  if (scenario === "loading") {
    workList.replaceChildren(loadingState());
    resultSummary.textContent = "Loading preview. No network request is running.";
  } else if (scenario === "error") {
    workList.replaceChildren(errorState());
    resultSummary.textContent = "Error preview. Retry restores local fixture presentation.";
  } else if (scenario === "empty" || rows.length === 0) {
    workList.replaceChildren(emptyState());
    resultSummary.textContent = `No ${filterLabels[currentFilter].toLowerCase()} cards in ${mode.label}.`;
  } else {
    workList.replaceChildren(...rows.map(renderCard));
    resultSummary.textContent = `${rows.length} fictional ${rows.length === 1 ? "card" : "cards"} · ${filterLabels[currentFilter]}`;
  }

  renderDetail();
  renderCompanion();
}

function renderCard(row, index) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "work-card";
  button.dataset.index = String(index);
  button.dataset.recordId = row.id;
  button.setAttribute("aria-current", String(index === selectedIndex));
  button.setAttribute("aria-label", `${row.title}. ${row.stateLabel}. ${row.health}`);

  const top = element("span", "card-top");
  const state = text("span", row.stateLabel);
  state.className = "state-label";
  state.dataset.tone = row.tone;
  state.dataset.symbol = row.symbol;
  top.append(state, text("span", row.context));
  const title = text("strong", row.title);
  const description = text("span", row.description);
  description.className = "card-copy";
  const meta = element("span", "card-meta");
  meta.append(text("span", `Owner ${row.owner}`), text("span", row.disposition));
  const foot = element("span", "card-foot");
  foot.append(text("code", row.evidence), text("span", row.health));
  button.append(top, title, description, meta, foot);
  button.addEventListener("click", () => {
    selectedIndex = index;
    acknowledgedId = null;
    renderSelection();
    openDetail();
  });
  item.append(button);
  return item;
}

function loadingState() {
  const item = document.createElement("li");
  const card = element("div", "loading-card");
  card.setAttribute("role", "status");
  card.append(text("h3", "Arranging the desk…"), text("p", "This deterministic preview performs no network request."));
  const dots = element("span", "loading-dots");
  dots.setAttribute("aria-hidden", "true");
  dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  card.append(dots);
  item.append(card);
  return item;
}

function emptyState() {
  const item = document.createElement("li");
  const card = element("div", "empty-card");
  card.append(text("h3", "This tray is clear."), text("p", `Choose another filter or drawer. ${fixture.project.name} stays selected.`));
  item.append(card);
  return item;
}

function errorState() {
  const item = document.createElement("li");
  const card = element("div", "error-card");
  card.setAttribute("role", "alert");
  card.append(text("h3", "The local preview could not arrange this tray."), text("p", "Your fixture context is intact. Retry returns to the default local state."));
  const retry = text("button", "Retry local preview");
  retry.type = "button";
  retry.addEventListener("click", () => applyScenario("default", true));
  card.append(retry);
  item.append(card);
  return item;
}

function moveSelection(delta) {
  if (["loading", "error", "empty"].includes(body.dataset.scenario)) return;
  const rows = visibleRows();
  if (!rows.length) return;
  selectedIndex = (selectedIndex + delta + rows.length) % rows.length;
  acknowledgedId = null;
  renderSelection(true);
  announce(rows[selectedIndex].title);
}

function renderSelection(focus = false) {
  workList.querySelectorAll("[data-index]").forEach((button, index) => button.setAttribute("aria-current", String(index === selectedIndex)));
  const selected = workList.querySelector(`[data-index="${selectedIndex}"]`);
  selected?.scrollIntoView({ block: "nearest" });
  if (focus) selected?.focus();
  renderDetail();
  renderCompanion();
}

function selectedRow() {
  if (["loading", "error", "empty"].includes(body.dataset.scenario)) return null;
  return visibleRows()[selectedIndex] ?? null;
}

function renderDetail() {
  const row = selectedRow();
  if (!row) {
    primaryAction.disabled = true;
    secondaryAction.disabled = true;
    detailHeading.replaceChildren(text("h2", body.dataset.scenario === "loading" ? "Local loading preview" : body.dataset.scenario === "error" ? "Local error preview" : "No matching card"));
    const section = element("section", "detail-section");
    section.append(text("h3", "Your place is preserved"), text("p", `The selected project remains ${fixture.project.name}. Choose Default, another filter, or another drawer.`));
    detailContent.replaceChildren(section);
    return;
  }

  primaryAction.disabled = false;
  secondaryAction.disabled = false;
  const state = text("span", row.stateLabel);
  state.className = "state-label";
  state.dataset.tone = row.tone;
  state.dataset.symbol = row.symbol;
  detailHeading.replaceChildren(state, text("h2", row.title), text("p", `${row.context} · owner ${row.owner}`));
  primaryAction.textContent = acknowledgedId === row.id ? "Undo preview acknowledgement" : row.action;

  const facts = element("section", "detail-grid");
  facts.setAttribute("aria-label", "Selected work summary");
  facts.append(fact("Disposition", row.disposition), fact("Health", row.health), fact("Source", row.source));

  const why = element("section", "detail-section");
  why.append(text("h3", "Why this is here"), text("p", row.description));
  const next = element("div", "next-note");
  next.append(text("strong", row.semanticState === "ambiguous" ? "Safe next action" : "Next action"), document.createElement("br"), row.next);
  why.append(next);

  const evidence = element("section", "detail-section");
  evidence.append(text("h3", "Evidence and identity"));
  const list = element("ul", "evidence-list");
  list.append(evidenceItem("record", row.id, row.semanticState), evidenceItem("revision", row.evidence, "shared fixture"), evidenceItem("reference", row.source, "invented"));
  evidence.append(list);

  const connections = element("section", "detail-section");
  connections.append(text("h3", "Connection health"));
  const connectionList = element("ul", "evidence-list");
  for (const connection of fixture.connections) connectionList.append(evidenceItem(connection.label, connection.state, connection.detail));
  connections.append(connectionList);

  detailContent.replaceChildren(facts, why, evidence, connections);
}

function fact(label, value) {
  const node = document.createElement("div");
  node.append(text("span", label), text("strong", value));
  return node;
}

function evidenceItem(label, value, state) {
  const item = document.createElement("li");
  item.append(text("span", label), text("code", value), text("span", state));
  return item;
}

function renderCompanion() {
  const row = selectedRow();
  if (!row) {
    companion.dataset.mood = body.dataset.scenario === "loading" ? "resting" : body.dataset.scenario === "error" ? "concerned" : "calm";
    companionMessage.textContent = body.dataset.scenario === "loading" ? "The desk is arranging local fixture cards." : body.dataset.scenario === "error" ? "The preview needs a local retry." : "This tray is clear, and your project stays selected.";
    companionDetail.textContent = body.dataset.scenario === "error" ? "Use Retry local preview. No remote action or data loss occurred." : "Mallow adds a gentle cue while the literal state remains written out.";
    return;
  }
  const serious = row.tone === "serious" || row.tone === "warning";
  companion.dataset.mood = acknowledgedId === row.id && !serious ? "bright" : serious ? "concerned" : row.tone === "healthy" ? "bright" : "calm";
  companionMessage.textContent = serious ? `${row.stateLabel}: ${row.title}` : acknowledgedId === row.id ? "Preview acknowledgement recorded. You can undo it." : `${row.stateLabel}: ${row.title}`;
  companionDetail.textContent = serious ? `${row.disposition}. ${row.next}` : `${row.health}. ${row.next}`;
}

function runPrimaryAction() {
  const row = selectedRow();
  if (!row) return;
  if (row.semanticState === "ambiguous") {
    announce(`Safe recovery remains required: ${row.next}. No retry was performed.`);
    return;
  }
  acknowledgedId = acknowledgedId === row.id ? null : row.id;
  renderDetail();
  renderCompanion();
  announce(acknowledgedId ? `Preview acknowledgement recorded for ${row.title}. Undo is available.` : `Preview acknowledgement removed for ${row.title}.`);
}

function openDetail() {
  if (!selectedRow()) return;
  roomGrid.dataset.mobileDetail = "true";
  workDetail.focus();
}

function closeDetail() {
  roomGrid.dataset.mobileDetail = "false";
  workList.querySelector(`[data-index="${selectedIndex}"]`)?.focus();
}

function openCommands() {
  if (commandDialog.open) {
    commandInput.focus();
    return;
  }
  dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : commandTrigger;
  commandInput.value = "";
  renderCommands("");
  commandDialog.showModal();
  commandInput.focus();
}

function restoreDialogFocus() {
  const target = dialogReturnFocus?.isConnected ? dialogReturnFocus : commandTrigger;
  dialogReturnFocus = null;
  target.focus();
}

function commandOptions(query) {
  const normalized = query.trim().toLowerCase();
  return [
    ...Object.entries(modes).map(([key, mode], index) => ({ label: `Open ${mode.label} drawer`, hint: String(index + 1), run: () => selectMode(key, true) })),
    ...tasks.map((task) => ({ label: `Shared task: ${task.prompt}`, hint: task.id, run: () => selectTask(task) })),
    { label: "Read connection health", hint: "connections", run: focusConnections },
  ].filter((option) => option.label.toLowerCase().includes(normalized));
}

function renderCommands(query) {
  const options = commandOptions(query);
  commandList.replaceChildren(...options.map((option) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.append(text("span", option.label), text("small", option.hint));
    button.addEventListener("click", () => executeCommand(option));
    item.append(button);
    return item;
  }));
}

function executeCommand(option) {
  dialogReturnFocus = null;
  commandDialog.close();
  requestAnimationFrame(option.run);
}

function handleCommandInputKeydown(event) {
  const options = commandOptions(commandInput.value);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    commandList.querySelector("button")?.focus();
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    [...commandList.querySelectorAll("button")].at(-1)?.focus();
  }
  if (event.key === "Enter" && options[0]) {
    event.preventDefault();
    executeCommand(options[0]);
  }
}

function handleCommandListKeydown(event) {
  const buttons = [...commandList.querySelectorAll("button")];
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
    commandDialog.close();
  }
}

function selectTask(task) {
  const identities = task.success.split(",");
  if (identities.every((id) => fixture.connections.some((connection) => connection.id === id))) {
    focusConnections(task.prompt);
    return;
  }
  const target = taskTargets[task.id];
  const location = target ? findIdentityInMode(target.mode, target.identity) : findIdentity(identities[0]);
  if (!location) return;
  currentMode = location.mode;
  currentFilter = "all";
  selectedIndex = location.index;
  acknowledgedId = null;
  roomGrid.dataset.mobileDetail = "false";
  filterButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === "all")));
  renderModes();
  applyScenario("default", false);
  workList.querySelector(`[data-record-id="${target?.identity ?? identities[0]}"]`)?.focus();
  announce(`${task.prompt} Target selected: ${identities.join(", ")}.`);
}

function findIdentity(id) {
  for (const mode of Object.keys(modes)) {
    const location = findIdentityInMode(mode, id);
    if (location) return location;
  }
  return null;
}

function findIdentityInMode(mode, id) {
  const index = modes[mode]?.rows.findIndex((row) => row.id === id) ?? -1;
  return index >= 0 ? { mode, index } : null;
}

function focusConnections(prompt = "Determine GitHub, API, and MCP connection health.") {
  connectionShelf.focus();
  const summary = [...connectionShelf.children].map((chip) => chip.textContent).join(", ");
  announce(`${prompt} ${summary}.`);
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

function text(tagName, value) {
  const node = document.createElement(tagName);
  node.textContent = value;
  return node;
}

function required(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Soft Companion is missing ${selector}`);
  return node;
}
