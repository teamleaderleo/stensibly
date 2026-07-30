import { frontendLabManifest } from "./manifest.js";

const id = document.body.dataset.variant;
const variant = frontendLabManifest.find((entry) => entry.id === id);
if (!variant || variant.status !== "planned") {
  throw new Error("Planned frontend lab route does not match the manifest");
}

text("#variant-title", variant.title);
text("#variant-thesis", variant.thesis);
text("#variant-owner", variant.owner);
text("#variant-route", variant.path);
text("#variant-status", variant.status);

const issueLink = required("#variant-issue");
issueLink.href = `https://github.com/teamleaderleo/stensibly/issues/${variant.issue}`;
issueLink.textContent = `Issue #${variant.issue}`;

const symbols = {
  "soft-companion": ["♡", "gentle orientation", "serious states stay explicit"],
  "field-console": ["◎", "object and alert awareness", "text-first fallback required"],
  "signal-atlas": ["↝", "guided causal storytelling", "source and time stay visible"],
  "studio-canvas": ["□", "artifact-first workspace", "local and accepted states differ"],
};
const [symbol, first, second] = symbols[variant.id];
const seed = required("#seed");
seed.append(
  seedRow(symbol, first, "design thesis"),
  seedRow("1", second, "shared task contract"),
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
  code.textContent = variant.id;
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
