const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
if (!fixtureApi) throw new Error("Signal Atlas requires the shared frontend labs fixture contract");
const routePolicy = globalThis.StensiblySignalAtlasPolicy;
if (!routePolicy) throw new Error("Signal Atlas requires its synchronous route policy contract");

const localRecordMetadata = Object.freeze([
  metadata("approve-release-note", "decision", "operator", "09:42 UTC", "7ac91de", "Review the wording, then approve it or return it for revision.", [50, 14]),
  metadata("moss", "worker", "Moss", "09:40 UTC", "lease-moss-14", "Open the evidence and let the bounded review continue.", [18, 33]),
  metadata("ember", "worker", "Ember", "09:28 UTC", "lease-ember-09", "Confirm the lease expired, then recover or reassign the work.", [82, 33]),
  metadata("repair-focus-order", "ready work", "unclaimed", "rank 1", "task-focus-01", "Repair shared focus order, then repeat keyboard evidence.", [21, 62]),
  metadata("deploy-amber", "operation", "operator", "09:36 UTC", "preview-amber-17", "Reconcile publication", [51, 55]),
  metadata("archive-coral", "operation", "Moss", "09:31 UTC", "archive-coral-04", "Open activity", [78, 69]),
  metadata("github", "connection", "provider", "09:41 UTC", "connection-github", "No recovery action is required.", [24, 90]),
  metadata("api", "connection", "provider", "09:41 UTC", "connection-api", "Allow the reconnect to finish, then recheck health.", [52, 90]),
  metadata("mcp", "connection", "provider", "09:39 UTC", "connection-mcp", "Use GitHub or API and preserve the offline explanation.", [80, 90]),
]);
const records = routePolicy.projectRecords(fixtureApi.frontendLabFixture, localRecordMetadata);

const chapters = Object.freeze([
  chapter({
    id: "decision",
    title: "A single decision holds the line",
    short: "Find the only item requiring a human choice.",
    kicker: "Chapter 1 · decision",
    narrative: "Paper Lantern is otherwise moving. The release note is the one point where automation stops and the operator must choose concise wording.",
    annotation: "The story begins with authority, not activity: one decision gates publication.",
    active: ["approve-release-note", "deploy-amber"],
    selected: "approve-release-note",
    route: "decision-publication",
  }),
  chapter({
    id: "workers",
    title: "Two workers, one unhealthy lease",
    short: "Separate active work from a lease that needs recovery.",
    kicker: "Chapter 2 · worker health",
    narrative: "Moss is reviewing evidence. Ember stopped heartbeating 12 minutes ago. The interface names both workers and writes lease health in text instead of turning every worker into an alarm.",
    annotation: "Healthy and unhealthy work remain visible together so recovery preserves context.",
    active: ["moss", "ember", "repair-focus-order"],
    selected: "ember",
    route: "workers-ready",
  }),
  chapter({
    id: "recommendation",
    title: "The first ready item has shared leverage",
    short: "Explain why focus order outranks the next polish task.",
    kicker: "Chapter 3 · recommendation",
    narrative: "Repair focus order ranks first because it unlocks comparable keyboard evidence across every visual lane. The recommendation states its leverage instead of presenting an unexplained score.",
    annotation: "A recommendation earns attention by naming the dependency it removes.",
    active: ["repair-focus-order", "moss", "deploy-amber"],
    selected: "repair-focus-order",
    route: "ready-publication",
  }),
  chapter({
    id: "ambiguity",
    title: "A timeout is not permission to retry",
    short: "Trace the missing receipt and safe reconciliation path.",
    kicker: "Chapter 4 · ambiguous operation",
    narrative: "The publication client timed out after dispatch. Because remote settlement is unknown, replay could duplicate the effect. The safe next action is evidence gathering.",
    annotation: "Ambiguity changes the action grammar: reconcile before retry.",
    active: ["deploy-amber", "api", "archive-coral", "approve-release-note"],
    selected: "deploy-amber",
    route: "publication-providers",
  }),
  chapter({
    id: "connections",
    title: "Provider health is mixed, not binary",
    short: "Read GitHub, API, and MCP as separate capabilities.",
    kicker: "Chapter 5 · connection health",
    narrative: "GitHub is healthy, the API is reconnecting, and MCP is offline. The project can continue through available paths because the interface keeps each provider capability explicit.",
    annotation: "The narrative ends with capability-level truth and an ordinary list of available paths.",
    active: ["github", "api", "mcp", "deploy-amber"],
    selected: "api",
    route: "provider-health",
  }),
]);

const routes = Object.freeze([
  route("decision-publication", "approve-release-note", "deploy-amber", "M50 14 C49 28 50 39 51 55"),
  route("workers-ready", "moss", "repair-focus-order", "M18 33 C18 43 19 52 21 62"),
  route("worker-delay", "ember", "deploy-amber", "M82 33 C72 40 63 48 51 55"),
  route("ready-publication", "repair-focus-order", "deploy-amber", "M21 62 C32 59 41 57 51 55"),
  route("publication-api", "deploy-amber", "api", "M51 55 C51 68 52 78 52 90"),
  route("publication-archive", "archive-coral", "deploy-amber", "M78 69 C68 64 60 59 51 55"),
  route("publication-github", "deploy-amber", "github", "M51 55 C43 68 34 80 24 90"),
  route("publication-mcp", "deploy-amber", "mcp", "M51 55 C62 69 71 80 80 90"),
]);

const ledgerEvents = Object.freeze([
  event("09:28 UTC", "workers", "ember", "Lease crossed the recovery threshold.", "unhealthy"),
  event("09:31 UTC", "ambiguity", "archive-coral", "Artifact archive recovery settled without duplicate writes.", "recovered"),
  event("09:36 UTC", "ambiguity", "deploy-amber", "Publication client timed out before receiving a provider receipt.", "ambiguous"),
  event("09:40 UTC", "workers", "moss", "Accessibility evidence review remained active and healthy.", "healthy"),
  event("09:41 UTC", "connections", "api", "API began refreshing a fictional short-lived session.", "reconnecting"),
  event("09:42 UTC", "decision", "approve-release-note", "Release wording remained the only human decision.", "attention"),
]);
for (const entry of ledgerEvents) routePolicy.chapterIndex(chapters, entry.chapterId, entry.recordId);

const stateLabels = Object.freeze({
  attention: "human decision",
  healthy: "healthy",
  unhealthy: "lease unhealthy",
  ready: "recommended ready work",
  ambiguous: "ambiguous settlement",
  recovered: "recovered",
  reconnecting: "reconnecting",
  offline: "offline",
});

const chapterList = required("#chapter-list");
const sceneKicker = required("#scene-kicker");
const sceneTitle = required("#scene-title");
const sceneNarrative = required("#scene-narrative");
const mapNodes = required("#map-nodes");
const routeLines = required("#route-lines");
const annotationTitle = required("#annotation-title");
const annotationCopy = required("#annotation-copy");
const staticGrid = required("#static-grid");
const evidenceBody = required("#evidence-body");
const previousButton = required("#previous-chapter");
const nextButton = required("#next-chapter");
const ledger = required("#ledger");
const ledgerList = required("#ledger-list");
const showLedgerButton = required("#show-ledger");
const closeLedgerButton = required("#close-ledger");
const announcer = required("#announcer");

let chapterIndex = 0;
let selectedRecordId = chapters[0].selected;
let returnFocus = showLedgerButton;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

renderChapterList();
renderStaticStory();
renderLedger();
renderChapter();

previousButton.addEventListener("click", () => selectChapter(chapterIndex - 1, true));
nextButton.addEventListener("click", () => selectChapter(chapterIndex + 1, true));
showLedgerButton.addEventListener("click", openLedger);
closeLedgerButton.addEventListener("click", closeLedger);

document.addEventListener("keydown", (keyboardEvent) => {
  if (!ledger.hidden) {
    if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault();
      closeLedger();
    }
    return;
  }
  if (["ArrowRight", "j", "J"].includes(keyboardEvent.key)) {
    keyboardEvent.preventDefault();
    selectChapter(chapterIndex + 1, true);
  }
  if (["ArrowLeft", "k", "K"].includes(keyboardEvent.key)) {
    keyboardEvent.preventDefault();
    selectChapter(chapterIndex - 1, true);
  }
  if (/^[1-5]$/.test(keyboardEvent.key)) {
    keyboardEvent.preventDefault();
    selectChapter(Number(keyboardEvent.key) - 1, true);
  }
  if (keyboardEvent.key.toLowerCase() === "l") {
    keyboardEvent.preventDefault();
    openLedger();
  }
});

function renderChapterList() {
  chapterList.replaceChildren(...chapters.map((entry, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.chapterId = entry.id;
    button.setAttribute("aria-current", index === chapterIndex ? "step" : "false");
    button.append(text("span", `0${index + 1}`, "chapter-number"), text("strong", entry.title), text("span", entry.short));
    button.addEventListener("click", () => selectChapter(index, true));
    item.append(button);
    return item;
  }));
}

function renderChapter() {
  const entry = chapters[chapterIndex];
  selectedRecordId = entry.active.includes(selectedRecordId) ? selectedRecordId : entry.selected;
  sceneKicker.textContent = entry.kicker;
  sceneTitle.textContent = entry.title;
  sceneNarrative.textContent = entry.narrative;
  annotationTitle.textContent = entry.title;
  annotationCopy.textContent = entry.annotation;
  previousButton.disabled = chapterIndex === 0;
  nextButton.disabled = chapterIndex === chapters.length - 1;
  nextButton.textContent = chapterIndex === chapters.length - 1 ? "End of story" : `Next: 0${chapterIndex + 2}`;
  chapterList.querySelectorAll("button").forEach((button, index) => button.setAttribute("aria-current", index === chapterIndex ? "step" : "false"));
  renderRoutes(entry);
  renderMap(entry);
  renderStaticStory();
  renderEvidence();
}

function renderRoutes(entry) {
  routeLines.replaceChildren(...routes.map((routeEntry) => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", routeEntry.path);
    path.dataset.active = String(routeEntry.id === entry.route || entry.active.includes(routeEntry.from) && entry.active.includes(routeEntry.to));
    return path;
  }));
}

function renderMap(entry) {
  mapNodes.replaceChildren(...records.map((recordEntry) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "map-node";
    button.dataset.recordId = recordEntry.id;
    button.dataset.state = recordEntry.state;
    button.style.left = `${recordEntry.position[0]}%`;
    button.style.top = `${recordEntry.position[1]}%`;
    button.hidden = !entry.active.includes(recordEntry.id);
    button.setAttribute("aria-current", String(recordEntry.id === selectedRecordId));
    button.setAttribute("aria-label", `${recordEntry.title}. ${stateLabels[recordEntry.state]}. ${recordEntry.summary}`);
    button.append(text("span", symbolFor(recordEntry.state), "node-symbol"), text("strong", recordEntry.title), text("small", stateLabels[recordEntry.state]));
    button.addEventListener("click", () => selectRecord(recordEntry.id, button));
    return button;
  }));
}

function renderStaticStory() {
  staticGrid.replaceChildren(...chapters.map((entry, index) => {
    const article = document.createElement("article");
    article.className = "static-card";
    article.id = `static-${entry.id}`;
    article.setAttribute("aria-current", String(index === chapterIndex));
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Open chapter 0${index + 1}`;
    button.addEventListener("click", () => selectChapter(index, true));
    article.append(text("span", `0${index + 1} · ${entry.kicker.replace(/^Chapter \d+ · /, "")}`, "chapter-number"), text("h4", entry.title), text("p", entry.narrative), button);
    return article;
  }));
}

function renderEvidence() {
  const recordEntry = byId(selectedRecordId);
  const providers = records.filter((entry) => entry.kind === "connection");
  evidenceBody.replaceChildren(
    text("span", stateLabels[recordEntry.state], "evidence-state"),
    text("h2", recordEntry.title, "evidence-title"),
    text("p", recordEntry.summary, "evidence-copy"),
    section("Exact evidence", evidenceList([
      ["Identity", recordEntry.id], ["Kind", recordEntry.kind], ["Owner", recordEntry.owner],
      ["Observed", recordEntry.time], ["Evidence head", recordEntry.evidence], ["Source", "Paper Lantern shared fictional fixture"],
    ])),
    section("Safe next action", elementWithChildren("div", "next-action", text("strong", recordEntry.nextAction))),
    section("Available providers", evidenceList(providers.map((entry) => [entry.title, stateLabels[entry.state]]))),
  );
}

function renderLedger() {
  ledgerList.replaceChildren(...ledgerEvents.map((entry) => {
    const recordEntry = byId(entry.recordId);
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Open ${recordEntry.title}`;
    button.addEventListener("click", () => {
      closeLedger(false);
      chapterIndex = routePolicy.chapterIndex(chapters, entry.chapterId, entry.recordId);
      selectedRecordId = entry.recordId;
      renderChapterList();
      renderChapter();
      evidenceBody.focus({ preventScroll: true });
      announce(`${recordEntry.title} selected from the complete ledger`);
    });
    item.append(text("time", entry.time), elementWithChildren("div", "", text("code", stateLabels[entry.state]), text("strong", recordEntry.title)), elementWithChildren("div", "", text("p", entry.copy), button));
    return item;
  }));
}

function selectChapter(index, moveViewport) {
  const bounded = Math.min(chapters.length - 1, Math.max(0, index));
  if (bounded === chapterIndex && !moveViewport) return;
  chapterIndex = bounded;
  selectedRecordId = chapters[chapterIndex].selected;
  renderChapter();
  if (moveViewport) {
    required("#scene").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    sceneTitle.focus({ preventScroll: true });
  }
  announce(`Chapter ${chapterIndex + 1}: ${chapters[chapterIndex].title}`);
}

function selectRecord(id, focusTarget) {
  selectedRecordId = id;
  renderMap(chapters[chapterIndex]);
  renderEvidence();
  focusTarget?.focus();
  const entry = byId(id);
  announce(`${entry.title}. ${stateLabels[entry.state]}.`);
}

function openLedger() {
  returnFocus = routePolicy.returnFocusTarget(document.activeElement, showLedgerButton, ledger, document.body);
  ledger.hidden = false;
  document.body.style.overflow = "hidden";
  closeLedgerButton.focus();
  announce("Complete static timeline opened");
}

function closeLedger(restore = true) {
  ledger.hidden = true;
  document.body.style.overflow = "";
  if (restore) returnFocus.focus();
  announce("Complete static timeline closed");
}

function metadata(id, kind, owner, time, evidence, nextAction, position) {
  return Object.freeze({ id, kind, owner, time, evidence, nextAction, position: Object.freeze(position) });
}
function chapter(value) { return Object.freeze({ ...value, active: Object.freeze([...value.active]) }); }
function event(time, chapterId, recordId, copy, state) { return Object.freeze({ time, chapterId, recordId, copy, state }); }
function route(id, from, to, path) { return Object.freeze({ id, from, to, path }); }
function symbolFor(state) {
  if (["attention", "ambiguous"].includes(state)) return "◆";
  if (["unhealthy", "offline"].includes(state)) return "×";
  if (state === "reconnecting") return "▲";
  if (state === "recovered") return "✓";
  return "●";
}
function byId(id) {
  const entry = records.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown Signal Atlas record: ${id}`);
  return entry;
}
function section(title, content) { return elementWithChildren("section", "evidence-section", text("h3", title), content); }
function evidenceList(entries) {
  const list = element("ul", "evidence-list");
  for (const [label, value] of entries) list.append(elementWithChildren("li", "", text("span", label, "meta-label"), text("strong", value)));
  return list;
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
  if (!node) throw new Error(`Signal Atlas is missing ${selector}`);
  return node;
}
function announce(message) {
  announcer.textContent = "";
  requestAnimationFrame(() => { announcer.textContent = message; });
}
