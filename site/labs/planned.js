const variants = Object.freeze({
  "soft-companion": Object.freeze({
    title: "Soft Companion",
    thesis: "A warm pastel productivity desk with tactile controls, gentle feedback, and an original companion character.",
    owner: "unclaimed",
    issue: 608,
    path: "./soft-companion/",
    symbol: "♡",
    first: "gentle orientation",
    second: "serious states stay explicit",
  }),
  "field-console": Object.freeze({
    title: "Field Console",
    thesis: "A dense operational view pairing exact object state, alert triage, topology, timeline, and detail.",
    owner: "unclaimed",
    issue: 610,
    path: "./field-console/",
    symbol: "◎",
    first: "object and alert awareness",
    second: "text-first fallback required",
  }),
  "signal-atlas": Object.freeze({
    title: "Signal Atlas",
    thesis: "An editorial map and timeline treatment for explaining incidents, dependencies, and evidence as a guided narrative.",
    owner: "unclaimed",
    issue: 611,
    path: "./signal-atlas/",
    symbol: "↝",
    first: "guided causal storytelling",
    second: "source and time stay visible",
  }),
  "studio-canvas": Object.freeze({
    title: "Studio Canvas",
    thesis: "An artifact-first workspace with work navigation, versions, evidence, comments, and commands around the selected output.",
    owner: "unclaimed",
    issue: 612,
    path: "./studio-canvas/",
    symbol: "□",
    first: "artifact-first workspace",
    second: "local and accepted states differ",
  }),
});

const id = document.body.dataset.variant;
const variant = variants[id];
if (!variant) throw new Error("Planned frontend lab route is unknown");

text("#variant-title", variant.title);
text("#variant-thesis", variant.thesis);
text("#variant-owner", variant.owner);
text("#variant-route", variant.path);
text("#variant-status", "planned");

const issueLink = required("#variant-issue");
issueLink.href = `https://github.com/teamleaderleo/stensibly/issues/${variant.issue}`;
issueLink.textContent = `Issue #${variant.issue}`;

const seed = required("#seed");
seed.append(
  seedRow(variant.symbol, variant.first, "design thesis"),
  seedRow("1", variant.second, "shared task contract"),
  seedRow("→", "Pick up the issue and replace this route with a complete fixture-backed prototype.", "next action"),
);

function seedRow(symbol, title, label) {
  const row = element("div", "seed-row");
  const icon = element("span", "seed-symbol");
  icon.textContent = symbol;
  const copy = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const detail = document.createElement("span");
  detail.textContent = label;
  copy.append(strong, detail);
  const code = document.createElement("code");
  code.textContent = id;
  row.append(icon, copy, code);
  return row;
}

function text(selector, value) {
  required(selector).textContent = value;
}

function element(tagName, className) {
  const node = document.createElement(tagName);
  node.className = className;
  return node;
}

function required(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Planned frontend lab route is missing ${selector}`);
  return node;
}
