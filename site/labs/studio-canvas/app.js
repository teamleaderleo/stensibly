const artifacts = Object.freeze([
  artifact({
    id: "approve-release-note",
    kind: "decision document",
    state: "proposed",
    title: "Release note: keyboard evidence",
    summary: "The only fictional artifact requiring a human decision before publication.",
    source: "Fixture issue #742",
    revision: "proposal-r3",
    freshness: "observed 09:42 UTC",
    authority: "operator approval required",
    persistence: "local fixture; not saved",
    owner: "operator",
    nextAction: "Review the proposed sentence, then approve it or return it for revision.",
    sections: [
      ["Proposed release note", "Stensibly Labs now preserves keyboard focus while switching work views and comparing frontend variants."],
      ["Decision requested", "Approve the concise sentence above or return it with one specific correction."],
      ["Publication boundary", "This preview does not save, approve, publish, or contact any external system."],
    ],
    evidence: ["keyboard-evidence.json", "Fixture revision 7ac91de", "Issue #742 review note"],
    comments: ["Moss: The wording accurately describes the fictional evidence.", "Operator: Decision pending."],
    versions: [
      version("proposal-r3", "proposed", "Current local proposal", "Stensibly Labs now preserves keyboard focus while switching work views and comparing frontend variants."),
      version("accepted-r2", "accepted", "Previously accepted wording", "Stensibly Labs improves keyboard navigation across frontend experiments."),
      version("draft-r1", "stale", "Superseded draft", "Keyboard support is better."),
    ],
    activity: ["09:42 · proposal-r3 prepared locally", "09:40 · evidence attached by Moss", "09:36 · accepted-r2 selected as comparison base"],
  }),
  artifact({
    id: "worker-health",
    kind: "worker brief",
    state: "attached",
    title: "Worker health brief",
    summary: "Moss is healthy; Ember has an expired fictional lease and a safe recovery path.",
    source: "Fixture worker projection",
    revision: "brief-w14",
    freshness: "observed 09:40 UTC",
    authority: "informational; recovery requires operator action",
    persistence: "attached fixture evidence",
    owner: "Moss",
    nextAction: "Confirm Ember stopped, then recover or reassign the expired lease.",
    sections: [
      ["Moss", "Healthy lease. Reviewing accessibility evidence."],
      ["Ember", "Lease expired 12 minutes ago. Safe reassignment is available."],
      ["Interpretation", "Worker presence and lease health are separate facts; neither is inferred from color."],
    ],
    evidence: ["lease-moss-14", "lease-ember-09", "worker-projection.fixture.json"],
    comments: ["Recovery note: no automatic reassignment occurs in this preview."],
    versions: [version("brief-w14", "attached", "Current attached brief", "Moss healthy; Ember lease expired 12 minutes ago."), version("brief-w13", "stale", "Previous observation", "Both workers recently active; lease expiry not yet observed.")],
    activity: ["09:40 · Moss heartbeat observed", "09:28 · Ember lease crossed recovery threshold"],
  }),
  artifact({
    id: "repair-focus-order",
    kind: "implementation plan",
    state: "local",
    title: "Plan: repair shared focus order",
    summary: "The top ready item because it unlocks keyboard evidence across every frontend lane.",
    source: "Fixture ready-work rank 1",
    revision: "plan-focus-01",
    freshness: "ranked 09:39 UTC",
    authority: "unclaimed ready work",
    persistence: "local plan; not attached",
    owner: "unclaimed",
    nextAction: "Repair the common focus sequence, then repeat keyboard evidence across every variant.",
    sections: [
      ["Why first", "A common focus repair removes a blocker for Quiet Control, Soft Companion, Field Console, Signal Atlas, and Studio Canvas."],
      ["Acceptance", "View switching preserves focus, narrow detail restores its origin, and command surfaces return focus deterministically."],
      ["Non-goal", "Do not restyle every variant or migrate frameworks while repairing the shared behavior."],
    ],
    evidence: ["task-focus-01", "shared task recommended-work", "cross-variant keyboard matrix"],
    comments: ["This plan is local and has not been claimed or saved."],
    versions: [version("plan-focus-01", "local", "Current local plan", "Repair common focus behavior before lane-specific polish.")],
    activity: ["09:39 · ranked first by fictional dependency leverage"],
  }),
  artifact({
    id: "deploy-amber",
    kind: "operation receipt",
    state: "stale",
    title: "Publication receipt: settlement unknown",
    summary: "The fictional client timed out after dispatch; retry could duplicate the effect.",
    source: "Fixture operation deploy-amber",
    revision: "receipt-missing",
    freshness: "last local observation 09:36 UTC",
    authority: "ambiguous remote settlement",
    persistence: "no remote receipt attached",
    owner: "operator",
    nextAction: "Read provider receipt and target state before accepting or retrying.",
    sections: [
      ["Observed", "The client dispatched publication and timed out before receiving a provider response."],
      ["Unknown", "Remote settlement may have succeeded, failed, or remained pending."],
      ["Safe action", "Reconcile the provider receipt and target state. Do not replay from this artifact."],
    ],
    evidence: ["preview-amber-17", "client timeout at 09:36 UTC", "remote receipt absent"],
    comments: ["No retry control is exposed in this preview."],
    versions: [version("receipt-missing", "stale", "Current incomplete receipt", "Dispatch known; settlement unknown."), version("archive-coral-04", "accepted", "Prior recovery example", "A stale lease recovered without duplicate writes.")],
    activity: ["09:36 · client timeout", "09:31 · prior archive recovery settled safely"],
  }),
  artifact({
    id: "connection-health",
    kind: "capability note",
    state: "accepted",
    title: "Provider capability note",
    summary: "GitHub is healthy, API is reconnecting, and MCP is offline in the fictional scenario.",
    source: "Fixture connection projection",
    revision: "capabilities-c7",
    freshness: "observed 09:41 UTC",
    authority: "accepted informational snapshot",
    persistence: "fixture projection only",
    owner: "provider adapters",
    nextAction: "Continue through healthy paths and preserve the explicit MCP offline explanation.",
    sections: [
      ["GitHub", "Healthy. Issue reads and bounded writes are available."],
      ["API", "Reconnecting a fictional short-lived session."],
      ["MCP", "Offline. GitHub and API remain explicit alternatives."],
    ],
    evidence: ["connection-github", "connection-api", "connection-mcp"],
    comments: ["Capability health is not collapsed into one global red or green state."],
    versions: [version("capabilities-c7", "accepted", "Current accepted snapshot", "GitHub healthy; API reconnecting; MCP offline."), version("capabilities-c6", "stale", "Previous snapshot", "GitHub and API healthy; MCP offline.")],
    activity: ["09:41 · API reconnect began", "09:39 · MCP recorded offline", "09:38 · GitHub issue reads confirmed healthy"],
  }),
]);

const tabs = Object.freeze(["evidence", "comments", "versions", "activity"]);
const workList = required("#work-list");
const artifactSheet = required("#artifact-sheet");
const inspectorTabs = required("#inspector-tabs");
const inspectorContent = required("#inspector-content");
const canvasIdentity = required("#canvas-identity");
const compareToggle = required("#compare-toggle");
const commandDialog = required("#command-dialog");
const commandInput = required("#command-input");
const commandList = required("#command-list");
const commandTrigger = required("#command-trigger");
const announcer = required("#announcer");

let selectedArtifactIndex = 0;
let selectedTabIndex = 0;
let compareVersionId = null;
let commandReturnFocus = commandTrigger;

renderWorkList();
renderInspectorTabs();
renderWorkspace();
renderCommands("");

required("#collapse-work").addEventListener("click", () => setCollapsed("work", true));
required("#collapse-inspector").addEventListener("click", () => setCollapsed("inspector", true));
required("#reopen-work").addEventListener("click", () => setCollapsed("work", false));
required("#reopen-inspector").addEventListener("click", () => setCollapsed("inspector", false));
compareToggle.addEventListener("click", toggleCompare);
commandTrigger.addEventListener("click", openCommands);
commandInput.addEventListener("input", () => renderCommands(commandInput.value));
commandDialog.addEventListener("close", () => commandReturnFocus?.focus());

document.querySelectorAll("[data-mobile-pane]").forEach((button) => {
  button.addEventListener("click", () => setMobilePane(button.dataset.mobilePane));
});

document.addEventListener("keydown", (keyboardEvent) => {
  const editing = keyboardEvent.target instanceof HTMLInputElement || keyboardEvent.target instanceof HTMLTextAreaElement || keyboardEvent.target instanceof HTMLSelectElement;
  if ((keyboardEvent.metaKey || keyboardEvent.ctrlKey) && keyboardEvent.key.toLowerCase() === "k") {
    keyboardEvent.preventDefault();
    openCommands();
    return;
  }
  if (!editing && keyboardEvent.key === "/") {
    keyboardEvent.preventDefault();
    openCommands();
    return;
  }
  if (commandDialog.open) return;
  if (!editing && ["j", "J", "ArrowDown"].includes(keyboardEvent.key)) {
    keyboardEvent.preventDefault();
    moveArtifact(1);
  }
  if (!editing && ["k", "K", "ArrowUp"].includes(keyboardEvent.key)) {
    keyboardEvent.preventDefault();
    moveArtifact(-1);
  }
  if (!editing && /^[1-3]$/.test(keyboardEvent.key)) {
    keyboardEvent.preventDefault();
    focusRegion(Number(keyboardEvent.key));
  }
  if (!editing && keyboardEvent.key === "]") {
    keyboardEvent.preventDefault();
    selectTab(selectedTabIndex + 1, true);
  }
  if (!editing && keyboardEvent.key === "[") {
    keyboardEvent.preventDefault();
    selectTab(selectedTabIndex - 1, true);
  }
});

function renderWorkList() {
  workList.replaceChildren(...artifacts.map((entry, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.artifactId = entry.id;
    button.setAttribute("aria-current", String(index === selectedArtifactIndex));
    button.setAttribute("aria-label", `${entry.title}. ${entry.state}. ${entry.summary}`);
    const top = element("span", "work-row-top");
    top.append(text("span", entry.kind, "eyebrow"), stateChip(entry.state));
    button.append(top, text("strong", entry.title), text("span", entry.summary, "work-summary"));
    button.addEventListener("click", () => selectArtifact(index, false));
    item.append(button);
    return item;
  }));
}

function renderInspectorTabs() {
  inspectorTabs.replaceChildren(...tabs.map((tab, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.tab = tab;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(index === selectedTabIndex));
    button.textContent = capitalize(tab);
    button.addEventListener("click", () => selectTab(index, false));
    return button;
  }));
}

function renderWorkspace() {
  const entry = selectedArtifact();
  workList.querySelectorAll("button").forEach((button, index) => button.setAttribute("aria-current", String(index === selectedArtifactIndex)));
  canvasIdentity.replaceChildren(text("span", `${entry.kind} · ${entry.revision}`, "eyebrow"), text("strong", entry.title));
  compareToggle.disabled = entry.versions.length < 2;
  compareToggle.setAttribute("aria-pressed", String(compareVersionId !== null));
  compareToggle.textContent = compareVersionId ? "Exit comparison" : "Compare revision";
  renderArtifact();
  renderInspector();
}

function renderArtifact() {
  const entry = selectedArtifact();
  const header = element("header", "artifact-header");
  const states = element("div", "artifact-state-row");
  states.append(stateChip(entry.state), text("span", entry.persistence, "mode-chip"));
  header.append(states, text("h2", entry.title), text("p", `${entry.source} · ${entry.freshness} · ${entry.authority}`));

  const body = element("div", "artifact-body");
  if (compareVersionId) {
    const base = entry.versions.find((candidate) => candidate.id === compareVersionId) ?? entry.versions[1];
    const current = entry.versions[0];
    body.append(
      text("h3", `Compare ${base.id} → ${current.id}`),
      elementWithChildren(
        "div",
        "diff-block",
        elementWithChildren("div", "diff-line", text("strong", "Earlier"), htmlText("del", base.content)),
        elementWithChildren("div", "diff-line", text("strong", "Current"), htmlText("ins", current.content)),
      ),
      elementWithChildren("p", "artifact-callout", text("strong", "Local comparison only"), document.createTextNode(" No restore, branch, approval, or save has occurred.")),
    );
  } else {
    for (const [heading, copy] of entry.sections) body.append(text("h3", heading), text("p", copy));
    body.append(elementWithChildren("p", "artifact-callout", text("strong", "Next action"), document.createTextNode(` ${entry.nextAction}`)));
  }
  artifactSheet.replaceChildren(header, body);
}

function renderInspector() {
  inspectorTabs.querySelectorAll("button").forEach((button, index) => button.setAttribute("aria-selected", String(index === selectedTabIndex)));
  const entry = selectedArtifact();
  const tab = tabs[selectedTabIndex];
  if (tab === "evidence") renderEvidence(entry);
  if (tab === "comments") renderComments(entry);
  if (tab === "versions") renderVersions(entry);
  if (tab === "activity") renderActivity(entry);
}

function renderEvidence(entry) {
  inspectorContent.replaceChildren(
    inspectorSection("Artifact identity", inspectorList([
      ["State", entry.state],
      ["Revision", entry.revision],
      ["Freshness", entry.freshness],
      ["Authority", entry.authority],
      ["Persistence", entry.persistence],
      ["Owner", entry.owner],
    ])),
    inspectorSection("Attached evidence", inspectorList(entry.evidence.map((value) => ["attached", value]))),
    inspectorSection("Next action", elementWithChildren("div", "next-action", text("strong", entry.nextAction))),
  );
}

function renderComments(entry) {
  const draft = document.createElement("textarea");
  draft.className = "comment-draft";
  draft.placeholder = "Write a local preview note…";
  draft.setAttribute("aria-label", "Local preview comment draft");
  const explain = text("p", "Typing here is local to this page instance. Nothing is saved, attached, submitted, or approved.", "work-summary");
  const action = document.createElement("button");
  action.type = "button";
  action.textContent = "Explain local-only state";
  action.addEventListener("click", () => announce("Comment remains local and unsaved. No submission occurred."));
  inspectorContent.replaceChildren(
    inspectorSection("Existing fixture comments", inspectorList(entry.comments.map((value) => ["comment", value]))),
    inspectorSection("Local draft", elementWithChildren("div", "", draft, explain, elementWithChildren("div", "inspector-actions", action))),
  );
}

function renderVersions(entry) {
  const list = element("ul", "version-list");
  for (const versionEntry of entry.versions) {
    const item = document.createElement("li");
    item.setAttribute("aria-current", String(versionEntry.id === entry.revision));
    const compare = document.createElement("button");
    compare.type = "button";
    compare.textContent = versionEntry.id === entry.revision ? "Current revision" : `Compare with ${versionEntry.id}`;
    compare.disabled = versionEntry.id === entry.revision;
    compare.addEventListener("click", () => {
      compareVersionId = versionEntry.id;
      renderWorkspace();
      artifactSheet.focus({ preventScroll: true });
      announce(`Comparing ${versionEntry.id} with ${entry.revision}. Local view only.`);
    });
    item.append(stateChip(versionEntry.state), text("strong", versionEntry.id), text("span", versionEntry.label), compare);
    list.append(item);
  }

  const restore = document.createElement("button");
  restore.type = "button";
  restore.textContent = "Describe restore or branch";
  restore.addEventListener("click", () => announce("A real restore or branch would require an explicit reviewed action. Nothing changed."));
  inspectorContent.replaceChildren(inspectorSection("Revision history", list), inspectorSection("Recovery boundary", elementWithChildren("div", "inspector-actions", restore)));
}

function renderActivity(entry) {
  inspectorContent.replaceChildren(
    inspectorSection("Activity", activityList(entry.activity)),
    inspectorSection("Current mode", inspectorList([
      ["mode", "review"],
      ["authority", entry.authority],
      ["persistence", entry.persistence],
    ])),
  );
}

function selectArtifact(index, focus) {
  selectedArtifactIndex = (index + artifacts.length) % artifacts.length;
  compareVersionId = null;
  renderWorkspace();
  if (focus) workList.querySelector(`[data-artifact-id="${selectedArtifact().id}"]`)?.focus();
  announce(`${selectedArtifact().title}. ${selectedArtifact().state}.`);
}

function moveArtifact(delta) {
  selectArtifact(selectedArtifactIndex + delta, true);
}

function selectTab(index, focus) {
  selectedTabIndex = (index + tabs.length) % tabs.length;
  renderInspector();
  if (focus) inspectorTabs.querySelectorAll("button")[selectedTabIndex]?.focus();
  announce(`${tabs[selectedTabIndex]} inspector`);
}

function toggleCompare() {
  const entry = selectedArtifact();
  compareVersionId = compareVersionId ? null : entry.versions[1]?.id ?? null;
  renderWorkspace();
  artifactSheet.focus({ preventScroll: true });
  announce(compareVersionId ? `Comparing with ${compareVersionId}. Local view only.` : "Revision comparison closed");
}

function setCollapsed(region, collapsed) {
  document.body.dataset[`${region}Collapsed`] = String(collapsed);
  const recovery = required(region === "work" ? "#reopen-work" : "#reopen-inspector");
  if (collapsed) recovery.focus();
  else required(region === "work" ? "#work-list button" : "#inspector-tabs button").focus();
  announce(`${region} region ${collapsed ? "collapsed" : "restored"}`);
}

function setMobilePane(pane) {
  if (!["work", "artifact", "inspector"].includes(pane)) return;
  document.body.dataset.mobilePane = pane;
  document.querySelectorAll("[data-mobile-pane]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mobilePane === pane)));
  const target = pane === "work" ? workList.querySelector("button") : pane === "artifact" ? artifactSheet : inspectorTabs.querySelector("button");
  target?.focus();
  announce(`${pane} pane`);
}

function focusRegion(number) {
  const target = [workList.querySelector("button"), artifactSheet, inspectorTabs.querySelector("button")][number - 1];
  target?.focus();
  announce(`Region ${number} focused`);
}

function openCommands() {
  if (commandDialog.open) return;
  commandReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : commandTrigger;
  commandInput.value = "";
  renderCommands("");
  commandDialog.showModal();
  commandInput.focus();
}

function renderCommands(query) {
  const normalized = query.trim().toLowerCase();
  const commands = [
    ...artifacts.map((entry, index) => ({ label: `Open ${entry.title}`, detail: entry.kind, run: () => selectArtifact(index, false) })),
    ...tabs.map((tab, index) => ({ label: `Open ${capitalize(tab)} inspector`, detail: "context panel", run: () => selectTab(index, false) })),
    { label: "Toggle revision comparison", detail: "local view only", run: toggleCompare },
    { label: "Collapse work region", detail: "recoverable layout", run: () => setCollapsed("work", true) },
    { label: "Collapse inspector region", detail: "recoverable layout", run: () => setCollapsed("inspector", true) },
  ].filter((entry) => `${entry.label} ${entry.detail}`.toLowerCase().includes(normalized));

  commandList.replaceChildren(...commands.map((entry) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.append(document.createTextNode(entry.label), text("span", entry.detail));
    button.addEventListener("click", () => {
      commandDialog.close();
      requestAnimationFrame(entry.run);
    });
    item.append(button);
    return item;
  }));
}

function selectedArtifact() {
  return artifacts[selectedArtifactIndex];
}

function artifact(value) {
  return Object.freeze({
    ...value,
    sections: Object.freeze(value.sections.map((entry) => Object.freeze(entry))),
    evidence: Object.freeze([...value.evidence]),
    comments: Object.freeze([...value.comments]),
    versions: Object.freeze([...value.versions]),
    activity: Object.freeze([...value.activity]),
  });
}

function version(id, state, label, content) {
  return Object.freeze({ id, state, label, content });
}

function stateChip(state) {
  const chip = text("span", state, "state-chip");
  chip.dataset.state = state;
  return chip;
}

function inspectorSection(title, content) {
  return elementWithChildren("section", "inspector-section", text("h3", title), content);
}

function inspectorList(entries) {
  const list = element("ul", "inspector-list");
  for (const [label, value] of entries) list.append(elementWithChildren("li", "", text("span", label, "meta-label"), text("strong", value)));
  return list;
}

function activityList(entries) {
  const list = element("ul", "activity-list");
  for (const value of entries) list.append(elementWithChildren("li", "", text("span", value)));
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

function htmlText(tagName, value) {
  return text(tagName, value);
}

function elementWithChildren(tagName, className, ...children) {
  const node = element(tagName, className);
  node.append(...children);
  return node;
}

function required(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Studio Canvas is missing ${selector}`);
  return node;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function announce(message) {
  announcer.textContent = "";
  requestAnimationFrame(() => { announcer.textContent = message; });
}
