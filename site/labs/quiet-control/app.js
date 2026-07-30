const views = {
  attention: {
    label: "Attention",
    icon: "!",
    description: "Decisions, ambiguity, and incidents that genuinely need you.",
    rows: [
      {
        id: "decision-104",
        status: "attention",
        badge: "needs decision",
        age: "12m",
        title: "Approve the next provider capability",
        ref: "Project Lumen · decision 104",
        owner: "operator",
        reason: "One bounded grant remains before the fictional worker can continue.",
        health: "Decision waiting",
        source: "Fixture issue 104",
        evidence: "demo-a41c",
        next: "Inspect the exact capability list, then approve or reject the grant.",
        disposition: "Human decision required",
      },
      {
        id: "ambiguous-22",
        status: "recover",
        badge: "ambiguous",
        age: "28m",
        title: "Reconcile a write after client timeout",
        ref: "Project Lumen · operation 22",
        owner: "Mica",
        reason: "The fictional client lost the result after dispatch, so replay could duplicate the effect.",
        health: "Remote settlement unknown",
        source: "Fixture operation 22",
        evidence: "demo-op22",
        next: "Read the remote receipt and target state before choosing accept or retry.",
        disposition: "Reconciliation required",
      },
    ],
  },
  active: {
    label: "Active",
    icon: "▶",
    description: "Current work, live leases, and the next automatic action.",
    rows: [
      {
        id: "active-1",
        status: "active",
        badge: "moving",
        age: "2m",
        title: "Compile the provider catalogue",
        ref: "Project Lumen · run 31",
        owner: "Mica",
        reason: "The fictional worker is validating the exact catalogue before publication.",
        health: "Lease healthy · 13m",
        source: "Fixture run 31",
        evidence: "demo-c31",
        next: "Finish checks and publish the source-only candidate.",
        disposition: "Verification running",
      },
      {
        id: "active-2",
        status: "recover",
        badge: "lease unhealthy",
        age: "19m",
        title: "Refresh the project context projection",
        ref: "Project Harbor · run 8",
        owner: "Pip",
        reason: "The lease expired while the last heartbeat still claimed active work.",
        health: "Lease expired · recovery available",
        source: "Fixture run 8",
        evidence: "demo-r8",
        next: "Confirm the worker stopped, then recover or reassign the run.",
        disposition: "Recovery eligible",
      },
    ],
  },
  ready: {
    label: "Ready",
    icon: "→",
    description: "Ranked work with a concise reason it is useful now.",
    rows: [
      {
        id: "ready-1",
        status: "ready",
        badge: "recommended",
        age: "p1",
        title: "Add explicit authenticated application modes",
        ref: "Project Lumen · task 17",
        owner: "unclaimed",
        reason: "This removes the login-page reading order and unlocks every later control-room view.",
        health: "Low overlap",
        source: "Fixture task 17",
        evidence: "demo-t17",
        next: "Add signed-out, connecting, authenticated, degraded, and editing modes.",
        disposition: "Ready to select",
      },
      {
        id: "ready-2",
        status: "ready",
        badge: "ready",
        age: "p2",
        title: "Create deterministic browser receipts",
        ref: "Project Harbor · task 9",
        owner: "unclaimed",
        reason: "The variants need comparable keyboard, responsive, and accessibility evidence.",
        health: "Dependencies available",
        source: "Fixture task 9",
        evidence: "demo-t9",
        next: "Define the first wide and narrow fixture-backed browser flow.",
        disposition: "Ready to select",
      },
    ],
  },
  recover: {
    label: "Recover",
    icon: "↺",
    description: "Stalled, expired, ambiguous, or superseded work with one recovery action.",
    rows: [
      {
        id: "recover-1",
        status: "recover",
        badge: "stale branch",
        age: "1h",
        title: "Close a superseded preview candidate",
        ref: "Project Lumen · candidate 6",
        owner: "Junco",
        reason: "A newer fictional candidate contains the accepted repair and the old branch still appears active.",
        health: "Main path healthy",
        source: "Fixture candidate 6",
        evidence: "demo-b6",
        next: "Confirm the newer revision, then close the superseded candidate with a handoff.",
        disposition: "Cleanup only",
      },
      {
        id: "recover-2",
        status: "recover",
        badge: "blocked",
        age: "2d",
        title: "Resume context publication after persistence lands",
        ref: "Project Harbor · task 3",
        owner: "Junco",
        reason: "The read surface waits for a fictional durable-state dependency.",
        health: "Blocked by fixture task 2",
        source: "Fixture task 3",
        evidence: "demo-t3",
        next: "Land the dependency, restack this task, and repeat compatibility checks.",
        disposition: "Dependency block",
      },
    ],
  },
};

let currentView = "attention";
let selectedIndex = 0;

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

renderNav();
renderView();
renderCommands("");

commandButton.addEventListener("click", openCommands);
required("#mobile-back").addEventListener("click", closeDetail);
document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => announce(`${button.textContent}: fixture action only`));
});
primaryAction.addEventListener("click", () => announce(`Next action: ${selectedRow().next}`));
commandInput.addEventListener("input", () => renderCommands(commandInput.value));
dialog.addEventListener("close", () => commandButton.focus());

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
    selectView(Object.keys(views)[Number(event.key) - 1]);
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
  if (!editing && event.key === "Enter") openDetail();
  if (event.key === "Escape" && workspace.dataset.mobileDetail === "true") closeDetail();
});

function renderNav() {
  navList.replaceChildren(...Object.entries(views).map(([key, view], index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.view = key;
    button.setAttribute("aria-current", key === currentView ? "page" : "false");
    button.title = `${view.label} (${index + 1})`;

    const icon = document.createElement("span");
    icon.textContent = view.icon;
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = view.label;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(view.rows.length);

    button.append(icon, label, count);
    button.addEventListener("click", () => selectView(key));
    item.append(button);
    return item;
  }));
}

function selectView(key) {
  if (!views[key]) return;
  currentView = key;
  selectedIndex = 0;
  workspace.dataset.mobileDetail = "false";
  renderNav();
  renderView();
  announce(`${views[key].label} view, ${views[key].rows.length} items`);
}

function renderView() {
  const view = views[currentView];
  required("#view-title").textContent = view.label;
  required("#view-description").textContent = view.description;
  workList.replaceChildren(...view.rows.map(renderRow));
  renderDetail();
}

function renderRow(row, index) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.index = String(index);
  button.setAttribute("aria-selected", String(index === selectedIndex));
  button.setAttribute("aria-label", row.title);

  const top = element("span", "row-top");
  const badge = element("span", `badge ${row.status}`);
  badge.textContent = row.badge;
  const age = document.createElement("span");
  age.textContent = row.age;
  top.append(badge, age);

  const title = document.createElement("strong");
  title.textContent = row.title;
  const meta = element("span", "row-meta");
  meta.append(textNode("span", row.ref), textNode("span", row.owner));
  const reason = element("span", "row-reason");
  reason.textContent = row.reason;
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
  const rows = views[currentView].rows;
  selectedIndex = (selectedIndex + delta + rows.length) % rows.length;
  renderSelection(true);
  announce(rows[selectedIndex].title);
}

function renderSelection(focus = false) {
  workList.querySelectorAll("[data-index]").forEach((button, index) => {
    button.setAttribute("aria-selected", String(index === selectedIndex));
  });
  const selected = workList.querySelector(`[data-index="${selectedIndex}"]`);
  selected?.scrollIntoView({ block: "nearest" });
  if (focus) selected?.focus();
  renderDetail();
}

function selectedRow() {
  return views[currentView].rows[selectedIndex];
}

function renderDetail() {
  const row = selectedRow();
  const badge = element("span", `badge ${row.status}`);
  badge.textContent = row.badge;
  const title = document.createElement("h2");
  title.textContent = row.title;
  const subtitle = document.createElement("p");
  subtitle.textContent = `${row.ref} · owner ${row.owner}`;
  detailTitle.replaceChildren(badge, title, subtitle);

  primaryAction.textContent = currentView === "attention"
    ? "Review decision"
    : currentView === "recover"
    ? "Start recovery"
    : "Open next action";

  const summary = element("section", "summary");
  summary.setAttribute("aria-label", "Current work summary");
  summary.append(
    summaryCard("Disposition", row.disposition),
    summaryCard("Health", row.health),
    summaryCard("Current source", row.source),
  );

  const why = section("Why this is here");
  why.append(textNode("p", row.reason));
  const next = element("div", "next");
  const nextLabel = document.createElement("strong");
  nextLabel.textContent = "Next action";
  next.append(nextLabel, document.createElement("br"), row.next);
  why.append(next);

  const evidence = section("Evidence");
  const evidenceList = element("ul", "evidence");
  evidenceList.append(
    evidenceRow("revision", row.evidence, "current fixture"),
    evidenceRow("source", row.source, "invented"),
    evidenceRow("verification", "exact candidate required", "pending"),
  );
  evidence.append(evidenceList);

  const activity = section("Activity");
  const activityList = element("ul", "evidence");
  activityList.append(
    activityRow(row.status, row.badge, row.reason, row.age),
    activityRow("ready", "next", row.next, "queued"),
  );
  activity.append(activityList, technicalDetails(row));

  detailContent.replaceChildren(summary, why, evidence, activity);
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
    ["Projection", "quiet-control-fixture/v1"],
    ["Authority", "display only"],
  ]) {
    list.append(textNode("dt", label), textNode("dd", value));
  }
  details.append(list);
  return details;
}

function openDetail() {
  workspace.dataset.mobileDetail = "true";
  detailPane.focus();
}

function closeDetail() {
  workspace.dataset.mobileDetail = "false";
  workList.querySelector(`[data-index="${selectedIndex}"]`)?.focus();
}

function openCommands() {
  commandInput.value = "";
  renderCommands("");
  dialog.showModal();
  commandInput.focus();
}

function renderCommands(query) {
  const normalized = query.trim().toLowerCase();
  const options = [
    ...Object.entries(views).map(([key, view], index) => ({
      label: `Go to ${view.label}`,
      hint: String(index + 1),
      run: () => selectView(key),
    })),
    { label: "Open selected detail", hint: "Enter", run: openDetail },
    { label: "Announce connection health", hint: "C", run: () => announce("GitHub and API healthy; fixture mode") },
  ].filter((option) => option.label.toLowerCase().includes(normalized));

  commands.replaceChildren(...options.map((option) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.append(textNode("span", option.label), textNode("small", option.hint));
    button.addEventListener("click", () => {
      option.run();
      dialog.close();
    });
    item.append(button);
    return item;
  }));
}

function announce(message) {
  announcer.textContent = "";
  requestAnimationFrame(() => {
    announcer.textContent = message;
  });
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
