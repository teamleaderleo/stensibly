import { frontendLabManifest } from "./manifest.js";

const grid = requiredElement("#variant-grid");
const compareButton = requiredElement("#compare-button");
const closeCompareButton = requiredElement("#close-compare");
const compareSection = requiredElement("#compare-section");
const compareGrid = requiredElement("#compare-grid");
const selectionSummary = requiredElement("#selection-summary");
const selectedIds = new Set(readInitialSelection());

renderCatalogue();
updateComparisonControls();

compareButton.addEventListener("click", openComparison);
closeCompareButton.addEventListener("click", closeComparison);

function renderCatalogue() {
  grid.replaceChildren(...frontendLabManifest.map(renderVariantCard));
}

function renderVariantCard(variant) {
  const card = element("article", "variant-card");
  card.dataset.variantId = variant.id;
  card.dataset.selected = String(selectedIds.has(variant.id));

  const head = element("div", "variant-head");
  const title = element("div", "variant-title");
  const heading = element("h3");
  heading.textContent = variant.title;
  const identity = element("p");
  identity.textContent = `${variant.path} · issue #${variant.issue}`;
  title.append(heading, identity);

  const status = element("span", `status status-${variant.status}`);
  status.textContent = variant.status;
  head.append(title, status);

  const thesis = element("p", "variant-thesis");
  thesis.textContent = variant.thesis;

  const support = element("ul", "support-list");
  support.setAttribute("aria-label", `${variant.title} intended support`);
  for (const item of variant.support) {
    const listItem = element("li");
    listItem.textContent = item;
    support.append(listItem);
  }

  const meta = element("div", "variant-meta");
  meta.append(
    metadata("Owner", variant.owner),
    metadata("Revision", variant.revision ?? "unpublished"),
    metadata("Source", `#${variant.issue}`),
  );

  const actions = element("div", "card-actions");
  const openLink = element("a", "card-link");
  openLink.href = variant.path;
  openLink.target = "_blank";
  openLink.rel = "noreferrer";
  openLink.textContent = "Open route";

  const choice = element("label", "compare-choice");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = selectedIds.has(variant.id);
  checkbox.value = variant.id;
  checkbox.setAttribute("aria-label", `Select ${variant.title} for comparison`);
  checkbox.addEventListener("change", () => toggleSelection(variant.id, checkbox));
  const choiceText = document.createElement("span");
  choiceText.textContent = "Compare";
  choice.append(checkbox, choiceText);

  actions.append(openLink, choice);
  card.append(head, thesis, support, meta, actions);
  return card;
}

function metadata(label, value) {
  const wrapper = document.createElement("div");
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  valueNode.title = value;
  wrapper.append(labelNode, valueNode);
  return wrapper;
}

function toggleSelection(id, checkbox) {
  if (checkbox.checked) {
    if (selectedIds.size >= 2) {
      checkbox.checked = false;
      selectionSummary.textContent = "Choose at most two variants.";
      return;
    }
    selectedIds.add(id);
  } else {
    selectedIds.delete(id);
  }
  syncSelectedCards();
  updateComparisonControls();
  persistSelection();
}

function syncSelectedCards() {
  for (const card of grid.querySelectorAll("[data-variant-id]")) {
    card.dataset.selected = String(selectedIds.has(card.dataset.variantId));
  }
}

function updateComparisonControls() {
  const selected = selectedVariants();
  compareButton.disabled = selected.length !== 2;
  selectionSummary.textContent = selected.length === 0
    ? "Select two variants to compare."
    : selected.length === 1
    ? `${selected[0].title} selected. Choose one more.`
    : `${selected[0].title} and ${selected[1].title} selected.`;
}

function openComparison() {
  const selected = selectedVariants();
  if (selected.length !== 2) return;
  compareGrid.replaceChildren(...selected.map(renderComparisonFrame));
  compareSection.hidden = false;
  compareSection.scrollIntoView({ block: "start" });
  closeCompareButton.focus({ preventScroll: true });
}

function renderComparisonFrame(variant) {
  const wrapper = element("article", "compare-frame");
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = variant.title;
  const direct = document.createElement("a");
  direct.href = variant.path;
  direct.target = "_blank";
  direct.rel = "noreferrer";
  direct.textContent = "Open directly";
  header.append(title, direct);

  const frame = document.createElement("iframe");
  frame.src = variant.path;
  frame.title = `${variant.title} isolated preview`;
  frame.loading = "eager";
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("sandbox", "allow-scripts");

  wrapper.append(header, frame);
  return wrapper;
}

function closeComparison() {
  compareGrid.replaceChildren();
  compareSection.hidden = true;
  compareButton.focus();
}

function selectedVariants() {
  return frontendLabManifest.filter((variant) => selectedIds.has(variant.id));
}

function readInitialSelection() {
  const ids = new URLSearchParams(window.location.search).get("compare")?.split(",") ?? [];
  const allowed = new Set(frontendLabManifest.map((variant) => variant.id));
  return [...new Set(ids.filter((id) => allowed.has(id)))].slice(0, 2);
}

function persistSelection() {
  const url = new URL(window.location.href);
  if (selectedIds.size) {
    url.searchParams.set("compare", [...selectedIds].join(","));
  } else {
    url.searchParams.delete("compare");
  }
  window.history.replaceState(null, "", url);
}

function element(tagName, className = "") {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}

function requiredElement(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Frontend labs catalogue is missing ${selector}`);
  return node;
}
