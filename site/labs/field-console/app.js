const records = Object.freeze([
  record({
    id: "approve-release-note",
    kind: "decision",
    state: "attention",
    title: "Approve the release note",
    summary: "Choose the concise wording before the fictional publication can settle.",
    owner: "operator",
    timestamp: "09:42 UTC",
    evidence: "7ac91de",
    priority: 1,
    nextAction: "Review the concise wording, then approve it or return it for revision.",
    actionLabel: "Review decision",
    position: [50, 11],
    task: "human-decision",
  }),
  record({
    id: "moss",
    kind: "worker",
    state: "healthy",
    title: "Moss",
    summary: "Reviewing accessibility evidence with a healthy fictional lease.",
    owner: "Moss",
    timestamp: "09:40 UTC",
    evidence: "lease-moss-14",
    priority: 5,
    nextAction: "Open the current evidence and allow the bounded review to continue.",
    actionLabel: "Open activity",
    position: [20, 31],
    task: "worker-health",
  }),
  record({
    id: "ember",
    kind: "worker",
    state: "unhealthy",
    title: "Ember",
    summary: "Lease expired 12 minutes ago; safe reassignment is available.",
    owner: "Ember",
    timestamp: "09:28 UTC",
    evidence: "lease-ember-09",
    priority: 2,
    nextAction: "Confirm the lease is expired, then recover or reassign the work.",
    actionLabel: "Start recovery",
    position: [80, 31],
    task: "worker-health",
  }),
  record({
    id: "repair-focus-order",
    kind: "ready work",
    state: "ready",
    title: "Repair focus order",
    summary: "Top recommendation because it unblocks keyboard evidence across every variant.",
    owner: "unclaimed",
    timestamp: "rank 1",
    evidence: "task-focus-01",
    priority: 3,
    nextAction: "Repair the shared focus order, then repeat keyboard evidence across every variant.",
    actionLabel: "Open recommendation",
    position: [20, 58],
    task: "recommended-work",
  }),
  record({
    id: "polish-empty-state",
    kind: "ready work",
    state: "ready",
    title: "Polish empty state",
    summary: "Second-ranked work after the common focus path is reliable.",
    owner: "unclaimed",
    timestamp: "rank 2",
    evidence: "task-empty-02",
    priority: 8,
    nextAction: "Take this after the shared focus repair has landed.",
    actionLabel: "Open next action",
    position: [18, 79],
    task: null,
  }),
  record({
    id: "deploy-amber",
    kind: "operation",
    state: "ambiguous",
    title: "Dashboard publication",
    summary: "Provider receipt is missing; remote settlement is unknown.",
    owner: "operator",
    timestamp: "09:36 UTC",
    evidence: "preview-amber-17",
    priority: 1,
    nextAction: "Read the remote receipt and target state before accepting or retrying.",
    actionLabel: "Reconcile before retry",
    position: [53, 54],
    task: "safe-reconciliation",
  }),
  record({
    id: "sync-violet",
    kind: "operation",
    state: "degraded",
    title: "GitHub context sync",
    summary: "Issue reads are current; review-thread evidence is delayed.",
    owner: "Moss",
    timestamp: "09:38 UTC",
    evidence: "sync-violet-22",
    priority: 4,
    nextAction: "Inspect delayed evidence without blocking healthy issue reads.",
    actionLabel: "View evidence",
    position: [81, 58],
    task: null,
  }),
  record({
    id: "archive-coral",
    kind: "operation",
    state: "recovered",
    title: "Artifact archive",
    summary: "Recovered from a stale lease without duplicate writes.",
    owner: "Moss",
    timestamp: "09:31 UTC",
    evidence: "archive-coral-04",
    priority: 7,
    nextAction: "Review the recovery receipt; no further action is required.",
    actionLabel: "Open activity",
    position: [51, 79],
    task: null,
  }),
  record({
    id: "github",
    kind: "connection",
    state: "healthy",
    title: "GitHub",
    summary: "Read and bounded write capabilities are available.",
    owner: "provider",
    timestamp: "09:41 UTC",
    evidence: "connection-github",
    priority: 6,
    nextAction: "No recovery action is required.",
    actionLabel: "Open connection",
    position: [35, 94],
    task: "connection-health",
  }),
  record({
    id: "api",
    kind: "connection",
    state: "reconnecting",
    title: "API",
    summary: "Refreshing a fictional short-lived session.",
    owner: "provider",
    timestamp: "09:41 UTC",
    evidence: "connection-api",
    priority: 5,
    nextAction: "Allow the bounded reconnect to finish, then recheck health.",
    actionLabel: "Inspect reconnect",
    position: [58, 94],
    task: "connection-health",
  }),
  record({
    id: "mcp",
    kind: "connection",
    state: "offline",
    title: "MCP",
    summary: "Unavailable in this preview scenario; other paths remain explicit.",
    owner: "provider",
    timestamp: "09:39 UTC",
    evidence: "connection-mcp",
    priority: 4,
    nextAction: "Use the available GitHub or API path and preserve the offline explanation.",
    actionLabel: "Open recovery note",
    position: [80, 94],
    task: "connection-health",
  }),
]);

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

let selectedId = "approve-release-note";
let currentFilter = "all";
let query = "";
let density = "comfortable";
let scenario = readScenario();

renderFilters();
renderAll();

searchInput.addEventListener("input", () => {
  query = searchInput.value.trim().toLowerCase();
  renderAll();
});

scenarioSelect.value = scenario;
scenarioSelect.addEventListener("change", () => {
  setScenario(scenarioSelect.value);
});

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
  renderScenario();
  const visible = visibleRecords();
  if (!visible.some((entry) => entry.id === selectedId)) selectedId = visible[0]?.id ?? null;
  renderHealth();
  renderList(visible);
  renderTopology(visible);
  renderRelationships();
  renderTimeline();
  renderDetail();
  resultSummary.textContent = `${visible.length} of ${scenarioRecords().length} fictional objects visible`;
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

function renderHealth() {
  const container = required("#connection-health");
  const connections = records.filter((entry) => entry.kind === "connection");
  container.replaceChildren(...connections.map((entry) => stateChip(entry.state, `${entry.title} ${stateLabels[entry.state]}`)));
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
    button.append(
      top,
      text("strong", entry.title, "row-title"),
      text("span", entry.summary, "row-summary"),
      metadataRow(entry),
    );
    button.addEventListener("click", () => activateRecord(entry.id, "list"));
    item.append(button);
    return item;
  }));
}

function renderTopology(visible) {
  const visibleIds = new Set(visible.map((entry) => entry.id));
  topology.replaceChildren();
  topologyLinks.replaceChildren();

  for (const link of relations) {
    if (!visibleIds.has(link.from) || !visibleIds.has(link.to)) continue;
    const from = byId(link.from);
    const to = byId(link.to);
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
    button.append(
      text("span", entry.kind, "node-kind"),
      text("strong", entry.title),
      text("small", stateLabels[entry.state]),
    );
    button.addEventListener("click", () => activateRecord(entry.id, "topology"));
    topology.append(button);
  }
}

function renderRelationships() {
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
    const from = byId(link.from);
    const to = byId(link.to);
    item.append(
      text("strong", `${from.title} → ${to.title}`),
      text("span", link.label, "relation-copy"),
      stateChip(link.critical ? "ambiguous" : "healthy", link.critical ? "decision-relevant relation" : "context relation"),
    );
    return item;
  }));
}

function renderTimeline() {
  timelineList.replaceChildren(...timeline.map((event) => {
    const item = document.createElement("li");
    item.dataset.recordId = event.recordId;
    item.setAttribute("aria-current", String(event.recordId === selectedId));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "timeline-button";
    button.append(
      elementWithChildren("span", "timeline-meta", stateChip(event.state, stateLabels[event.state]), text("time", `${event.time} UTC`)),
      text("strong", byId(event.recordId).title),
      text("span", event.text, "row-summary"),
    );
    button.addEventListener("click", () => activateRecord(event.recordId, "timeline"));
    item.replaceChildren(button);
    return item;
  }));
}

function renderDetail() {
  const entry = selectedId ? byId(selectedId) : null;
  if (!entry || scenario === "error") {
    detailBody.replaceChildren(
      text("h2", scenario === "error" ? "Projection unavailable" : "No object selected", "detail-title"),
      text("p", "Project Paper Lantern remains selected. Use the local scenario control or choose another object.", "detail-copy"),
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
    const prefix = entry.state === "ambiguous" ? "No retry performed. Safe next action" : "Fixture action only. Next action";
    announce(`${prefix}: ${entry.nextAction}`);
  });

  const source = document.createElement("button");
  source.type = "button";
  source.textContent = "Open evidence summary";
  source.addEventListener("click", () => announce(`Evidence ${entry.evidence}. Fictional local fixture only.`));

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
      detailList(records.filter((candidate) => candidate.kind === "connection").map((candidate) => `${candidate.title}: ${stateLabels[candidate.state]} — ${candidate.summary}`)),
    ),
  ];

  detailBody.replaceChildren(
    mobileBack,
    text("p", entry.kind, "eyebrow"),
    stateChip(entry.state, stateLabels[entry.state]),
    text("h2", entry.title, "detail-title"),
    text("p", entry.summary, "detail-copy"),
    elementWithChildren("div", "detail-actions", source, primary),
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

function visibleRecords() {
  if (scenario === "empty" || scenario === "error") return [];
  return scenarioRecords().filter((entry) => {
    const filterMatch = currentFilter === "all"
      || entry.kind === currentFilter
      || (currentFilter === "attention" && ["attention", "unhealthy", "ambiguous", "degraded", "reconnecting", "offline"].includes(entry.state));
    const queryMatch = !query || `${entry.title} ${entry.summary} ${entry.owner} ${entry.id}`.toLowerCase().includes(query);
    return filterMatch && queryMatch;
  });
}

function scenarioRecords() {
  if (scenario !== "degraded") return records;
  return records.map((entry) => entry.id === "sync-violet"
    ? Object.freeze({ ...entry, summary: "Review-thread evidence is delayed by 18 minutes; issue reads remain current." })
    : entry);
}

function activateRecord(id, source) {
  selectedId = id;
  renderAll();
  const selector = source === "topology" ? `#topology [data-record-id="${id}"]` : `#object-list [data-record-id="${id}"]`;
  document.querySelector(selector)?.focus();
  if (window.matchMedia("(max-width: 48rem)").matches) {
    document.body.dataset.mobileDetail = "true";
    required("#detail-body").focus({ preventScroll: true });
  }
  announce(`${byId(id).title} selected. ${stateLabels[byId(id).state]}.`);
}

function moveSelection(delta) {
  const visible = visibleRecords();
  if (!visible.length) return;
  const index = Math.max(0, visible.findIndex((entry) => entry.id === selectedId));
  const next = visible[(index + delta + visible.length) % visible.length];
  selectedId = next.id;
  renderAll();
  objectList.querySelector(`[data-record-id="${next.id}"]`)?.focus();
  announce(`${next.title}. ${stateLabels[next.state]}.`);
}

function focusRegion(number) {
  const targets = [
    objectList.querySelector("button"),
    topology.querySelector("button"),
    detailBody,
    timelineList.querySelector("button"),
  ];
  const target = targets[number - 1];
  target?.focus();
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
  selectedId = value === "degraded" ? "sync-violet" : "approve-release-note";
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

function detailGrid(entries) {
  const wrapper = element("div", "detail-grid");
  for (const [label, value] of entries) {
    wrapper.append(elementWithChildren("div", "", text("span", label, "meta-label"), text("strong", value)));
  }
  return wrapper;
}

function detailList(entries) {
  const list = element("ul", "detail-list");
  for (const entry of entries) list.append(elementWithChildren("li", "", text("span", entry)));
  return list;
}

function emptyItem(copy) {
  return elementWithChildren("li", "empty-panel", text("span", copy));
}

function emptyPanel(copy) {
  return elementWithChildren("div", "empty-panel", text("span", copy));
}

function byId(id) {
  const entry = records.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown Field Console record: ${id}`);
  return entry;
}

function record(value) {
  return Object.freeze(value);
}

function relation(from, to, label, critical) {
  return Object.freeze({ from, to, label, critical });
}

function element(tagName, className = "") {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

function text(tagName, value, className = "") {
  const node = element(tagName, className);
  node.textContent = value;
  return node;
}

function elementWithChildren(tagName, className, ...children) {
  const node = element(tagName, className);
  node.append(...children);
  return node;
}

function required(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Field Console is missing ${selector}`);
  return node;
}

function announce(message) {
  announcer.textContent = "";
  requestAnimationFrame(() => { announcer.textContent = message; });
}
