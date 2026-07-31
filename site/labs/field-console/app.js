const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
if (!fixtureApi) throw new Error("Field Console requires the shared frontend labs fixture contract");
const policy = globalThis.StensiblyFieldConsolePolicy;
if (!policy) throw new Error("Field Console requires its shared-fixture projection policy");
const fixture = fixtureApi.frontendLabFixture;

const metadata = Object.freeze({
  "approve-release-note": meta({
    kind: "decision",
    owner: "operator",
    timestamp: "09:42 UTC",
    evidence: "7ac91de",
    priority: 1,
    nextAction: "Review the concise wording, then approve it or return it for revision.",
    position: [50, 11],
    task: "human-decision",
  }),
  moss: meta({
    kind: "worker",
    owner: "Moss",
    timestamp: "09:40 UTC",
    evidence: "lease-moss-14",
    priority: 5,
    nextAction: "Open the current evidence and allow the bounded review to continue.",
    position: [20, 31],
    task: "worker-health",
  }),
  ember: meta({
    kind: "worker",
    owner: "Ember",
    timestamp: "09:28 UTC",
    evidence: "lease-ember-09",
    priority: 2,
    nextAction: "Confirm the lease is expired, then recover or reassign the work.",
    position: [80, 31],
    task: "worker-health",
  }),
  "repair-focus-order": meta({
    kind: "ready work",
    owner: "unclaimed",
    timestamp: "rank 1",
    evidence: "task-focus-01",
    priority: 3,
    nextAction: "Repair the shared focus order, then repeat keyboard evidence across every variant.",
    position: [20, 58],
    task: "recommended-work",
  }),
  "polish-empty-state": meta({
    kind: "ready work",
    owner: "unclaimed",
    timestamp: "rank 2",
    evidence: "task-empty-02",
    priority: 8,
    nextAction: "Take this after the shared focus repair has landed.",
    position: [18, 79],
    task: null,
  }),
  "deploy-amber": meta({
    kind: "operation",
    owner: "operator",
    timestamp: "09:36 UTC",
    evidence: "preview-amber-17",
    priority: 1,
    nextAction: "Read the remote receipt and target state before accepting or retrying.",
    position: [53, 54],
    task: "safe-reconciliation",
  }),
  "sync-violet": meta({
    kind: "operation",
    owner: "Moss",
    timestamp: "09:38 UTC",
    evidence: "sync-violet-22",
    priority: 4,
    nextAction: "Inspect delayed evidence without blocking healthy issue reads.",
    position: [81, 58],
    task: null,
  }),
  "archive-coral": meta({
    kind: "operation",
    owner: "Moss",
    timestamp: "09:31 UTC",
    evidence: "archive-coral-04",
    priority: 7,
    nextAction: "Review the recovery receipt; no further action is required.",
    position: [51, 79],
    task: null,
  }),
  github: meta({
    kind: "connection",
    owner: "provider",
    timestamp: "09:41 UTC",
    evidence: "connection-github",
    priority: 6,
    nextAction: "No recovery action is required.",
    position: [35, 94],
    task: "connection-health",
  }),
  api: meta({
    kind: "connection",
    owner: "provider",
    timestamp: "09:41 UTC",
    evidence: "connection-api",
    priority: 5,
    nextAction: "Allow the bounded reconnect to finish, then recheck health.",
    position: [58, 94],
    task: "connection-health",
  }),
  mcp: meta({
    kind: "connection",
    owner: "provider",
    timestamp: "09:39 UTC",
    evidence: "connection-mcp",
    priority: 4,
    nextAction: "Use the available GitHub or API path and preserve the offline explanation.",
    position: [80, 94],
    task: "connection-health",
  }),
});

const baseRecords = Object.freeze(Object.entries(metadata).map(([id, details]) => Object.freeze({ id, ...details })));

const relations = Object.freeze([
  relation("approve-release-note", "deploy-amber", "Decision gates publication", true),
  relation("moss", "repair-focus-order", "Worker reviews shared focus evidence", false),
  relation("ember", "sync-violet", "Expired lease leaves sync evidence delayed", true),
  relation("repair-focus-order", "deploy-amber", "Keyboard proof is required before publication", true),
  relation("archive-coral", "deploy-amber", "Prior recovery informs reconciliation", false),
  relation("deploy-amber", "github", "Publication source and review evidence", false),
  relation("deploy-amber", "api", "Remote settlement receipt", true),
  relation("deploy-amber", "mcp", "Optional preview path currently offline", false),
  relation("sync-violet", "github", "Issue reads remain healthy", false),
]);

const timeline = Object.freeze([
  { time: "09:28", state: "unhealthy", recordId: "ember", text: "Ember lease crossed the recovery threshold." },
  { time: "09:31", state: "recovered", recordId: "archive-coral", text: "Artifact archive recovery settled without duplicate writes." },
  { time: "09:36", state: "ambiguous", recordId: "deploy-amber", text: "Publication client timed out before receiving a provider receipt." },
  { time: "09:38", state: "degraded", recordId: "sync-violet", text: "Review-thread projection became delayed; issue reads stayed current." },
  { time: "09:41", state: "reconnecting", recordId: "api", text: "API began refreshing a fictional short-lived session." },
  { time: "09:42", state: "attention", recordId: "approve-release-note", text: "Release wording remains the only human decision." },
]);

const filterDefinitions = Object.freeze([
  ["all", "All objects"],
  ["attention", "Needs action"],
  ["worker", "Workers"],
  ["ready work", "Ready"],
  ["operation", "Operations"],
  ["connection", "Connections"],
]);

const stateLabels = Object.freeze({
  attention: "human decision",
  healthy: "healthy",
  unhealthy: "lease unhealthy",
  ready: "ready",
  ambiguous: "ambiguous settlement",
  degraded: "degraded",
  recovered: "recovered",
  reconnecting: "reconnecting",
  offline: "offline",
});

const objectList = required("#object-list");
const topology = required("#topology");
const topologyLinks = required("#topology-links");
const filters = required("#filters");
const searchInput = required("#object-search");
const resultSummary = required("#result-summary");
const relationshipSummary = required("#relationship-summary");
const timelineList = required("#timeline-list");
const detailBody = required("#detail-body");
const scenarioPanel = required("#scenario-panel");
const scenarioSelect = required("#scenario-select");
const densityToggle = required("#density-toggle");
const densityValue = required("#density-value");
const announcer = required("#announcer");
const mobileBack = required("#mobile-back");

let selectedId = fixture.decision.id;
let currentFilter = "all";
let query = "";
let density = "comfortable";
let scenario = readScenario();
let projection = projectedRecords();

renderFilters();
renderAll();

searchInput.addEventListener("input", () => {
  query = searchInput.value.trim().toLowerCase();
  renderAll();
});

scenarioSelect.value = scenario;
scenarioSelect.addEventListener("change", () => setScenario(scenarioSelect.value));
densityToggle.addEventListener("click", toggleDensity);
mobileBack.addEventListener("click", closeMobileDetail);

document.addEventListener("keydown", (event) => {
  const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
  if (!editing && event.key === "/") {
    event.preventDefault();
    searchInput.focus();
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
  if (!editing && event.key.toLowerCase() === "d") {
    event.preventDefault();
    toggleDensity();
    return;
  }
  if (!editing && /^[1-4]$/.test(event.key)) {
    event.preventDefault();
    focusRegion(Number(event.key));
    return;
  }
  if (event.key === "Escape" && document.body.dataset.mobileDetail === "true") closeMobileDetail();
});

function renderAll() {
  projection = projectedRecords();
  renderScenario();
  const visible = visibleRecords(projection);
  if (!visible.some((entry) => entry.id === selectedId)) selectedId = visible[0]?.id ?? null;
  renderHealth(projection);
  renderList(visible);
  renderTopology(visible, projection);
  renderRelationships(projection);
  renderTimeline(projection);
  renderDetail(projection);
  resultSummary.textContent = `${visible.length} of ${projection.length} fictional objects visible`;
}

function renderFilters() {
  filters.replaceChildren(...filterDefinitions.map(([value, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.filter = value;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(currentFilter === value));
    button.addEventListener("click", () => {
      currentFilter = value;
      filters.querySelectorAll("button").forEach((candidate) => candidate.setAttribute("aria-pressed", String(candidate === button)));
      renderAll();
      announce(`${label} filter selected`);
    });
    return button;
  }));
}

function renderHealth(source) {
  const container = required("#connection-health");
  const connections = source.filter((entry) => entry.kind === "connection");
  container.replaceChildren(...connections.map((entry) => stateChip(entry.state, `${entry.title} ${stateLabels[entry.state]}`)));
  container.setAttribute("aria-label", `Connection health: ${connections.map((entry) => `${entry.title} ${stateLabels[entry.state]}`).join(", ")}`);
}

function renderList(visible) {
  if (scenario === "error") {
    objectList.replaceChildren(emptyItem("Object projection unavailable. Reset the local scenario to recover."));
    return;
  }
  if (!visible.length) {
    objectList.replaceChildren(emptyItem("No objects match this local view. Change the filter, search, or scenario."));
    return;
  }
  objectList.replaceChildren(...visible.map((entry) => {
    const item = document.createElement("li");
    item.className = "object-row";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.recordId = entry.id;
    button.setAttribute("aria-current", String(entry.id === selectedId));
    button.setAttribute("aria-label", `${entry.title}. ${stateLabels[entry.state]}. ${entry.summary}`);
    const top = element("span", "row-top");
    top.append(stateChip(entry.state, stateLabels[entry.state]), text("span", entry.timestamp));
    button.append(top, text("strong", entry.title, "row-title"), text("span", entry.summary, "row-summary"), metadataRow(entry));
    button.addEventListener("click", () => activateRecord(entry.id, "list"));
    item.append(button);
    return item;
  }));
}

function renderTopology(visible, source) {
  const visibleIds = new Set(visible.map((entry) => entry.id));
  topology.replaceChildren();
  topologyLinks.replaceChildren();

  for (const link of relations) {
    if (!visibleIds.has(link.from) || !visibleIds.has(link.to)) continue;
    const from = byId(link.from, source);
    const to = byId(link.to, source);
    if (!from || !to) continue;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(from.position[0]));
    line.setAttribute("y1", String(from.position[1]));
    line.setAttribute("x2", String(to.position[0]));
    line.setAttribute("y2", String(to.position[1]));
    line.dataset.critical = String(link.critical);
    topologyLinks.append(line);
  }

  if (scenario === "error") {
    topology.replaceChildren(emptyPanel("Topology projection unavailable. Text context and reset controls remain available."));
    return;
  }
  if (!visible.length) {
    topology.replaceChildren(emptyPanel("No topology nodes match this local view."));
    return;
  }

  for (const entry of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "topology-node";
    button.dataset.recordId = entry.id;
    button.dataset.state = entry.state;
    button.style.left = `${entry.position[0]}%`;
    button.style.top = `${entry.position[1]}%`;
    button.setAttribute("aria-current", String(entry.id === selectedId));
    button.setAttribute("aria-label", `${entry.kind}: ${entry.title}. ${stateLabels[entry.state]}.`);
    button.append(text("span", entry.kind, "node-kind"), text("strong", entry.title), text("small", stateLabels[entry.state]));
    button.addEventListener("click", () => activateRecord(entry.id, "topology"));
    topology.append(button);
  }
}

function renderRelationships(source) {
  if (!selectedId) {
    relationshipSummary.replaceChildren(emptyItem("Select an object to read its topology relationships in text."));
    return;
  }
  const related = relations.filter((link) => link.from === selectedId || link.to === selectedId);
  if (!related.length) {
    relationshipSummary.replaceChildren(emptyItem("This object has no modeled dependencies in the fictional topology."));
    return;
  }
  relationshipSummary.replaceChildren(...related.map((link) => {
    const item = document.createElement("li");
    const from = byId(link.from, source);
    const to = byId(link.to, source);
    item.append(
      text("strong", `${from?.title ?? link.from} → ${to?.title ?? link.to}`),
      text("span", link.label, "relation-copy"),
      stateChip(link.critical ? "ambiguous" : "healthy", link.critical ? "decision-relevant relation" : "context relation"),
    );
    return item;
  }));
}

function renderTimeline(source) {
  timelineList.replaceChildren(...timeline.map((event) => {
    const item = document.createElement("li");
    item.dataset.recordId = event.recordId;
    item.setAttribute("aria-current", String(event.recordId === selectedId));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "timeline-button";
    button.append(
      elementWithChildren("span", "timeline-meta", stateChip(event.state, stateLabels[event.state]), text("time", `${event.time} UTC`)),
      text("strong", byId(event.recordId, source)?.title ?? event.recordId),
      text("span", event.text, "row-summary"),
    );
    button.addEventListener("click", () => activateRecord(event.recordId, "timeline"));
    item.replaceChildren(button);
    return item;
  }));
}

function renderDetail(source) {
  const entry = selectedId ? byId(selectedId, source) : null;
  if (!entry || scenario === "error") {
    detailBody.replaceChildren(
      text("h2", scenario === "error" ? "Projection unavailable" : "No object selected", "detail-title"),
      text("p", `Project ${fixture.project.name} remains selected. Use the local scenario control or choose another object.`, "detail-copy"),
      resetScenarioButton(),
    );
    return;
  }

  const incoming = relations.filter((link) => link.to === entry.id).length;
  const outgoing = relations.filter((link) => link.from === entry.id).length;
  const primary = document.createElement("button");
  primary.type = "button";
  primary.className = "primary";
  primary.textContent = entry.actionLabel;
  primary.addEventListener("click", () => {
    const prefix = entry.state === "ambiguous" ? "No retry performed. Safe next action" : "Preview only. Next action";
    announce(`${prefix}: ${entry.nextAction}. No product action was performed.`);
  });

  const evidence = document.createElement("button");
  evidence.type = "button";
  evidence.textContent = "Read evidence summary";
  evidence.addEventListener("click", () => announce(`Evidence ${entry.evidence}. Fictional local fixture only.`));

  const sections = [
    elementWithChildren(
      "section",
      "detail-section",
      text("h3", "Exact object"),
      detailGrid([
        ["Identity", entry.id],
        ["Kind", entry.kind],
        ["Owner", entry.owner],
        ["Observed", entry.timestamp],
        ["Evidence head", entry.evidence],
        ["Priority", String(entry.priority)],
      ]),
    ),
    elementWithChildren(
      "section",
      "detail-section",
      text("h3", "Topology in text"),
      text("p", `${incoming} incoming relation${incoming === 1 ? "" : "s"}; ${outgoing} outgoing relation${outgoing === 1 ? "" : "s"}.`, "detail-copy"),
      text("p", entry.nextAction, "detail-copy"),
    ),
    elementWithChildren(
      "section",
      "detail-section",
      text("h3", "Connection health"),
      detailList(source.filter((candidate) => candidate.kind === "connection").map((candidate) => `${candidate.title}: ${stateLabels[candidate.state]} — ${candidate.summary}`)),
    ),
  ];

  detailBody.replaceChildren(
    mobileBack,
    text("p", entry.kind, "eyebrow"),
    stateChip(entry.state, stateLabels[entry.state]),
    text("h2", entry.title, "detail-title"),
    text("p", entry.summary, "detail-copy"),
    elementWithChildren("div", "detail-actions", evidence, primary),
    ...sections,
  );
}

function renderScenario() {
  document.body.dataset.scenario = scenario;
  scenarioPanel.hidden = scenario === "default";
  if (scenario === "default") return;
  const copy = {
    empty: ["empty", "Local empty scenario: no objects are projected. Project identity and recovery controls remain visible."],
    degraded: ["degraded", "Local degraded scenario: review evidence is delayed while issue reads and explicit recovery remain available."],
    error: ["error", "Local error scenario: object and topology projections are unavailable. No network retry occurs."],
  }[scenario];
  scenarioPanel.dataset.state = copy[0];
  scenarioPanel.replaceChildren(text("strong", copy[0]), document.createTextNode(` — ${copy[1]} `), resetScenarioButton());
}

function visibleRecords(source) {
  if (scenario === "empty" || scenario === "error") return [];
  return source.filter((entry) => {
    const filterMatch = currentFilter === "all"
      || entry.kind === currentFilter
      || (currentFilter === "attention" && ["attention", "unhealthy", "ambiguous", "degraded", "reconnecting", "offline"].includes(entry.state));
    const queryMatch = !query || `${entry.title} ${entry.summary} ${entry.owner} ${entry.id}`.toLowerCase().includes(query);
    return filterMatch && queryMatch;
  });
}

function projectedRecords() {
  return policy.projectRecords(baseRecords, scenario);
}

function activateRecord(id, source) {
  selectedId = id;
  renderAll();
  const selector = source === "topology" ? `#topology [data-record-id="${id}"]` : `#object-list [data-record-id="${id}"]`;
  document.querySelector(selector)?.focus();
  if (window.matchMedia("(max-width: 48rem)").matches) {
    document.body.dataset.mobileDetail = "true";
    detailBody.focus({ preventScroll: true });
  }
  const entry = byId(id, projection);
  if (entry) announce(`${entry.title} selected. ${stateLabels[entry.state]}.`);
}

function moveSelection(delta) {
  const visible = visibleRecords(projection);
  if (!visible.length) return;
  const index = Math.max(0, visible.findIndex((entry) => entry.id === selectedId));
  const next = visible[(index + delta + visible.length) % visible.length];
  selectedId = next.id;
  renderAll();
  objectList.querySelector(`[data-record-id="${next.id}"]`)?.focus();
  announce(`${next.title}. ${stateLabels[next.state]}.`);
}

function focusRegion(number) {
  const targets = [objectList.querySelector("button"), topology.querySelector("button"), detailBody, timelineList.querySelector("button")];
  targets[number - 1]?.focus();
  announce(`Region ${number} focused`);
}

function toggleDensity() {
  density = density === "comfortable" ? "compact" : "comfortable";
  document.body.dataset.density = density;
  densityValue.textContent = density;
  densityToggle.setAttribute("aria-pressed", String(density === "compact"));
  announce(`${density} density`);
}

function setScenario(value) {
  if (!["default", "empty", "degraded", "error"].includes(value)) return;
  scenario = value;
  selectedId = value === "degraded" ? "sync-violet" : fixture.decision.id;
  const url = new URL(window.location.href);
  if (value === "default") url.searchParams.delete("scenario");
  else url.searchParams.set("scenario", value);
  window.history.replaceState(null, "", url);
  renderAll();
  announce(`${value} local scenario`);
}

function readScenario() {
  const value = new URLSearchParams(window.location.search).get("scenario") ?? "default";
  return ["default", "empty", "degraded", "error"].includes(value) ? value : "default";
}

function closeMobileDetail() {
  document.body.dataset.mobileDetail = "false";
  objectList.querySelector(`[data-record-id="${selectedId}"]`)?.focus();
}

function resetScenarioButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Restore default fixture";
  button.addEventListener("click", () => {
    scenarioSelect.value = "default";
    setScenario("default");
  });
  return button;
}

function meta(value) {
  return Object.freeze({ ...value, position: Object.freeze([...value.position]) });
}

function relation(from, to, label, critical) {
  return Object.freeze({ from, to, label, critical });
}

function byId(id, source = projection) {
  return source.find((entry) => entry.id === id) ?? null;
}

function metadataRow(entry) {
  const wrapper = element("span", "row-meta");
  wrapper.append(text("span", entry.kind), text("span", entry.owner), text("code", entry.evidence));
  return wrapper;
}

function stateChip(state, label) {
  const chip = element("span", "state-chip");
  chip.dataset.state = state;
  chip.textContent = label;
  return chip;
}

function detailGrid(rows) {
  const grid = element("dl", "detail-grid");
  for (const [label, value] of rows) grid.append(text("dt", label), text("dd", value));
  return grid;
}

function detailList(rows) {
  const list = element("ul", "detail-list");
  for (const row of rows) list.append(text("li", row));
  return list;
}

function emptyItem(message) {
  const item = text("li", message);
  item.className = "empty-state";
  return item;
}

function emptyPanel(message) {
  return text("p", message, "empty-state");
}

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function text(tag, value, className) {
  const node = element(tag, className);
  node.textContent = value;
  return node;
}

function elementWithChildren(tag, className, ...children) {
  const node = element(tag, className);
  node.append(...children);
  return node;
}

function required(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Missing required Field Console element: ${selector}`);
  return node;
}

function announce(message) {
  announcer.textContent = "";
  requestAnimationFrame(() => {
    announcer.textContent = message;
  });
}
