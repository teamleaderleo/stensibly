const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
if (!fixtureApi) throw new Error("Field Console requires the shared frontend labs fixture contract");

const { frontendLabFixture: fixture, frontendLabTasks: tasks } = fixtureApi;
const references = Object.fromEntries(fixture.references.map((reference) => [reference.kind, reference]));
const taskIdsByRecord = buildTaskIdsByRecord(tasks);
const records = buildRecords();

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
  { time: "09:28", tone: "unhealthy", recordId: "ember", text: "Ember lease crossed the recovery threshold." },
  { time: "09:31", tone: "recovered", recordId: "archive-coral", text: "Artifact archive recovery settled without duplicate writes." },
  { time: "09:36", tone: "ambiguous", recordId: "deploy-amber", text: "Publication client timed out before receiving a provider receipt." },
  { time: "09:38", tone: "degraded", recordId: "sync-violet", text: "Review-thread projection became delayed; issue reads stayed current." },
  { time: "09:41", tone: "reconnecting", recordId: "api", text: "API began refreshing a fictional short-lived session." },
  { time: "09:42", tone: "attention", recordId: "approve-release-note", text: "Release wording remains the only human decision." },
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

function buildRecords() {
  const revision = references.revision?.value ?? "fixture-revision";
  const issue = references.issue?.value ?? "fixture-issue";
  const deployment = references.deployment?.value ?? "fixture-deployment";
  const decision = fixture.decision;

  const result = [
    record({
      id: decision.id,
      kind: "decision",
      state: decision.state,
      tone: "attention",
      title: decision.title,
      summary: decision.detail,
      owner: "operator",
      timestamp: "09:42 UTC",
      evidence: revision,
      source: issue,
      priority: 1,
      nextAction: "Read the shared decision wording and choose approve or return-for-revision outside this preview.",
      actionLabel: "Read decision guidance",
      position: [50, 11],
      task: taskIdsByRecord.get(decision.id) ?? null,
    }),
    ...fixture.workers.map((worker, index) => record({
      id: worker.id,
      kind: "worker",
      state: worker.state,
      tone: worker.state,
      title: worker.label,
      summary: worker.detail,
      owner: worker.label,
      timestamp: index === 0 ? "09:40 UTC" : "09:28 UTC",
      evidence: revision,
      source: issue,
      priority: index === 0 ? 5 : 2,
      nextAction: worker.state === "healthy"
        ? "Read the current fixture evidence and allow the bounded review to continue."
        : "Confirm the fixture lease is expired, then recover or reassign work in the product.",
      actionLabel: worker.state === "healthy" ? "Read activity guidance" : "Read recovery guidance",
      position: index === 0 ? [20, 31] : [80, 31],
      task: taskIdsByRecord.get(worker.id) ?? null,
    })),
    ...fixture.readyWork.map((work, index) => record({
      id: work.id,
      kind: "ready work",
      state: work.state,
      tone: work.state,
      title: work.title,
      summary: work.reason,
      owner: "unclaimed",
      timestamp: `rank ${work.rank}`,
      evidence: revision,
      source: issue,
      priority: work.rank === 1 ? 3 : 8,
      nextAction: work.rank === 1
        ? "Read why the shared focus repair ranks first, then select it in the product."
        : "Read this after the shared focus repair is complete.",
      actionLabel: work.rank === 1 ? "Read recommendation" : "Read next-action guidance",
      position: index === 0 ? [20, 58] : [18, 79],
      task: taskIdsByRecord.get(work.id) ?? null,
    })),
    ...fixture.operations.map((operation, index) => record({
      id: operation.id,
      kind: "operation",
      state: operation.state,
      tone: operation.state,
      title: operation.title,
      summary: operation.detail,
      owner: index === 1 ? "Moss" : "operator",
      timestamp: ["09:36 UTC", "09:38 UTC", "09:31 UTC"][index],
      evidence: operation.id === "deploy-amber" ? deployment : revision,
      source: operation.id === "deploy-amber" ? deployment : issue,
      priority: [1, 4, 7][index],
      nextAction: operation.state === "ambiguous" ? `${operation.detail} ${operation.action}.` : operation.action,
      actionLabel: operation.state === "ambiguous"
        ? "Read: Reconcile before retry"
        : operation.state === "degraded"
          ? "Read evidence guidance"
          : "Read recovery receipt",
      position: [[53, 54], [81, 58], [51, 79]][index],
      task: taskIdsByRecord.get(operation.id) ?? null,
    })),
    ...fixture.connections.map((connection, index) => record({
      id: connection.id,
      kind: "connection",
      state: connection.state,
      tone: connection.state,
      title: connection.label,
      summary: connection.detail,
      owner: "provider",
      timestamp: ["09:41 UTC", "09:41 UTC", "09:39 UTC"][index],
      evidence: revision,
      source: issue,
      priority: [6, 5, 4][index],
      nextAction: connection.state === "healthy"
        ? "Read the current fixture capability; no recovery action is required."
        : connection.state === "reconnecting"
          ? "Read the reconnect explanation, then recheck health in the product."
          : "Read the offline explanation and use an available path in the product.",
      actionLabel: "Read connection guidance",
      position: [[35, 94], [58, 94], [80, 94]][index],
      task: taskIdsByRecord.get(connection.id) ?? null,
    })),
  ];

  return Object.freeze(result);
}

function buildTaskIdsByRecord(sharedTasks) {
  const result = new Map();
  for (const task of sharedTasks) {
    for (const identity of task.success.split(",")) result.set(identity, task.id);
  }
  return result;
}

function renderAll() {
  renderScenario();
  const projected = projectedRecords();
  const visible = visibleRecords(projected);
  if (!visible.some((entry) => entry.id === selectedId)) selectedId = visible[0]?.id ?? null;
  renderHealth(projected);
  renderList(visible);
  renderTopology(visible, projected);
  renderRelationships(projected);
  renderTimeline(projected);
  renderDetail(projected);
  resultSummary.textContent = `${visible.length} of ${projected.length} fictional objects visible`;
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

function renderHealth(projected) {
  const container = required("#connection-health");
  const connections = projected.filter((entry) => entry.kind === "connection");
  container.replaceChildren(...connections.map((entry) => stateChip(entry.tone, `${entry.title} ${stateLabel(entry)}`)));
  container.setAttribute("aria-label", `Connection health: ${connections.map((entry) => `${entry.title} ${stateLabel(entry)}`).join(", ")}`);
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
    button.setAttribute("aria-label", `${entry.title}. ${stateLabel(entry)}. ${entry.summary}`);
    const top = element("span", "row-top");
    top.append(stateChip(entry.tone, stateLabel(entry)), text("span", entry.timestamp));
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

function renderTopology(visible, projected) {
  const visibleIds = new Set(visible.map((entry) => entry.id));
  topology.replaceChildren();
  topologyLinks.replaceChildren();

  for (const link of relations) {
    if (!visibleIds.has(link.from) || !visibleIds.has(link.to)) continue;
    const from = byId(link.from, projected);
    const to = byId(link.to, projected);
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
    button.dataset.state = entry.tone;
    button.style.left = `${entry.position[0]}%`;
    button.style.top = `${entry.position[1]}%`;
    button.setAttribute("aria-current", String(entry.id === selectedId));
    button.setAttribute("aria-label", `${entry.kind}: ${entry.title}. ${stateLabel(entry)}.`);
    button.append(
      text("span", entry.kind, "node-kind"),
      text("strong", entry.title),
      text("small", stateLabel(entry)),
    );
    button.addEventListener("click", () => activateRecord(entry.id, "topology"));
    topology.append(button);
  }
}

function renderRelationships(projected) {
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
    const from = byId(link.from, projected);
    const to = byId(link.to, projected);
    item.append(
      text("strong", `${from.title} → ${to.title}`),
      text("span", link.label, "relation-copy"),
      stateChip(link.critical ? "ambiguous" : "healthy", link.critical ? "decision-relevant relation" : "context relation"),
    );
    return item;
  }));
}

function renderTimeline(projected) {
  timelineList.replaceChildren(...timeline.map((event) => {
    const entry = byId(event.recordId, projected);
    const item = document.createElement("li");
    item.dataset.recordId = event.recordId;
    item.setAttribute("aria-current", String(event.recordId === selectedId));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "timeline-button";
    button.append(
      elementWithChildren("span", "timeline-meta", stateChip(event.tone, stateLabels[event.tone]), text("time", `${event.time} UTC`)),
      text("strong", entry.title),
      text("span", event.text, "row-summary"),
    );
    button.addEventListener("click", () => activateRecord(event.recordId, "timeline"));
    item.replaceChildren(button);
    return item;
  }));
}

function renderDetail(projected) {
  const entry = selectedId ? byId(selectedId, projected) : null;
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
    if (entry.state === "ambiguous") {
      announce(`Safe recovery guidance: ${entry.nextAction}. No retry was performed.`);
      return;
    }
    announce(`Fixture-only guidance: ${entry.nextAction}. No product action was performed.`);
  });

  const source = document.createElement("button");
  source.type = "button";
  source.textContent = "Read evidence summary";
  source.addEventListener("click", () => announce(`Evidence ${entry.evidence}. Source ${entry.source}. Fictional local fixture only.`));

  const sections = [
    elementWithChildren(
      "section",
      "detail-section",
      text("h3", "Exact object"),
      detailGrid([
        ["Identity", entry.id],
        ["Kind", entry.kind],
        ["Fixture state", entry.state],
        ["Owner", entry.owner],
        ["Observed", entry.timestamp],
        ["Evidence head", entry.evidence],
        ["Authority", "Fixture guidance only"],
        ["Persistence", "Page instance only; nothing saved"],
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
      detailList(projected.filter((candidate) => candidate.kind === "connection")
        .map((candidate) => `${candidate.title}: ${stateLabel(candidate)} — ${candidate.summary}`)),
    ),
  ];

  detailBody.replaceChildren(
    mobileBack,
    text("p", entry.kind, "eyebrow"),
    stateChip(entry.tone, stateLabel(entry)),
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

function projectedRecords() {
  if (scenario !== "degraded") return records;
  return Object.freeze(records.map((entry) => entry.id === "sync-violet"
    ? Object.freeze({ ...entry, summary: "Fictional degraded preview: review-thread evidence is delayed by 18 minutes; issue reads remain current." })
    : entry));
}

function visibleRecords(projected) {
  if (scenario === "empty" || scenario === "error") return [];
  return projected.filter((entry) => {
    const filterMatch = currentFilter === "all"
      || entry.kind === currentFilter
      || (currentFilter === "attention" && ["attention", "unhealthy", "ambiguous", "degraded", "reconnecting", "offline"].includes(entry.tone));
    const queryMatch = !query || `${entry.title} ${entry.summary} ${entry.owner} ${entry.id}`.toLowerCase().includes(query);
    return filterMatch && queryMatch;
  });
}

function activateRecord(id, source) {
  selectedId = id;
  renderAll();
  const selector = source === "topology" ? `#topology [data-record-id="${id}"]` : source === "timeline" ? `#timeline-list li[data-record-id="${id}"] button` : `#object-list [data-record-id="${id}"]`;
  document.querySelector(selector)?.focus();
  if (window.matchMedia("(max-width: 48rem)").matches) {
    document.body.dataset.mobileDetail = "true";
    detailBody.focus({ preventScroll: true });
  }
  const entry = byId(id, projectedRecords());
  announce(`${entry.title} selected. ${stateLabel(entry)}.`);
}

function moveSelection(delta) {
  const visible = visibleRecords(projectedRecords());
  if (!visible.length) return;
  const index = Math.max(0, visible.findIndex((entry) => entry.id === selectedId));
  const next = visible[(index + delta + visible.length) % visible.length];
  selectedId = next.id;
  renderAll();
  objectList.querySelector(`[data-record-id="${next.id}"]`)?.focus();
  announce(`${next.title}. ${stateLabel(next)}.`);
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

function metadataRow(entry) {
  const wrapper = element("span", "row-meta");
  wrapper.append(text("span", entry.kind), text("span", entry.owner), text("code", entry.evidence));
  return wrapper;
}

function stateLabel(entry) {
  if (entry.kind === "decision") return stateLabels.attention;
  return stateLabels[entry.tone] ?? entry.state;
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

function byId(id, projected) {
  const entry = projected.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown Field Console record: ${id}`);
  return entry;
}

function record(value) {
  return Object.freeze({ ...value, position: Object.freeze([...value.position]) });
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
