(() => {
  "use strict";

  const globalName = "StensiblyFrontendLabFixtures";
  const app = document.querySelector("#app");
  if (!(app instanceof HTMLElement)) throw new Error("Work Pulse app root is missing");

  const scenario = admitScenario(new URLSearchParams(globalThis.location.search).get("scenario"));
  markCurrentScenario(scenario);

  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, globalName);
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.writable
      || descriptor.enumerable
      || descriptor.configurable
    ) {
      throw new Error("The shared Labs fixture contract is unavailable");
    }
    const api = descriptor.value;
    if (!api || typeof api !== "object" || !Object.isFrozen(api)) {
      throw new Error("The shared Labs fixture contract is incompatible");
    }
    const fixtureDescriptor = Object.getOwnPropertyDescriptor(api, "frontendLabFixture");
    if (!fixtureDescriptor || !("value" in fixtureDescriptor)) {
      throw new Error("The shared Labs fixture is unavailable");
    }
    const parserDescriptor = Object.getOwnPropertyDescriptor(api, "parseFrontendLabFixture");
    if (
      !parserDescriptor
      || !("value" in parserDescriptor)
      || typeof parserDescriptor.value !== "function"
    ) {
      throw new Error("The shared Labs fixture parser is unavailable");
    }

    const fixture = Reflect.apply(
      parserDescriptor.value,
      undefined,
      [fixtureDescriptor.value],
    );
    if (!fixture || typeof fixture !== "object" || !Object.isFrozen(fixture)) {
      throw new Error("The shared Labs fixture parser returned an incompatible result");
    }
    app.replaceChildren(renderWorkPulse(fixture, scenario));
    app.setAttribute("aria-busy", "false");
  } catch (error) {
    app.replaceChildren(renderFailure(error));
    app.setAttribute("aria-busy", "false");
  }

  function renderWorkPulse(fixture, activeScenario) {
    const fragment = document.createDocumentFragment();
    fragment.append(projectHeader(fixture.project, activeScenario));

    if (activeScenario === "empty") {
      fragment.append(emptyView());
      return fragment;
    }

    const attention = attentionItems(fixture);
    fragment.append(summaryStrip(fixture, attention));
    fragment.append(attentionLedger(attention));
    fragment.append(workGrid(fixture));
    fragment.append(evidenceAndConnections(fixture));
    return fragment;
  }

  function projectHeader(project, activeScenario) {
    const section = element("section", { className: "project-brief", "aria-labelledby": "project-title" });
    const copy = element("div", { className: "project-copy" }, [
      element("p", { className: "section-kicker", text: "Current project" }),
      element("h2", { id: "project-title", text: project.name }),
      element("p", { className: "project-summary", text: project.summary }),
    ]);
    const facts = element("dl", { className: "brief-facts" }, [
      fact("View", "Fixture-only"),
      fact("Scenario", activeScenario === "default" ? "Normal" : capitalize(activeScenario)),
      fact("Evidence model", "Accepted records"),
    ]);
    section.append(copy, facts);

    if (activeScenario === "degraded") {
      section.append(element("p", {
        className: "scenario-banner",
        role: "status",
        text: "Degraded preview: connection loss remains explicit while the last accepted fixture evidence stays readable.",
      }));
    }
    return section;
  }

  function summaryStrip(fixture, attention) {
    return element("section", { className: "summary-strip", "aria-label": "Work Pulse summary" }, [
      metric("Human decisions", fixture.decision.state === "ready" ? "1" : "0", "One explicit judgement request"),
      metric("Workers", String(fixture.workers.length), "Each with literal health"),
      metric("Attention items", String(attention.length), "Ranked by consequence, not noise"),
      metric("Evidence refs", String(fixture.references.length), "Exact external identities"),
    ]);
  }

  function attentionLedger(items) {
    const section = element("section", { id: "attention", className: "panel attention-panel", "aria-labelledby": "attention-title" });
    section.append(sectionHeading(
      "attention-title",
      "Waiting and recoverable",
      "Only concrete decisions, stale authority, ambiguous effects, and degraded connections appear here.",
    ));
    const list = element("div", { className: "attention-list" });
    for (const item of items) {
      list.append(element("article", {
        className: "attention-card",
        "data-state": item.state,
        "data-record-id": item.id,
      }, [
        element("div", { className: "card-heading" }, [
          element("span", { className: "source-label", text: item.source }),
          stateChip(item.state),
        ]),
        element("h3", { text: item.title }),
        element("p", { text: item.detail }),
        element("p", { className: "next-action", text: `Next: ${item.action}` }),
      ]));
    }
    section.append(list);
    return section;
  }

  function workGrid(fixture) {
    const section = element("section", { className: "work-grid", "aria-label": "Current work and operations" });

    const workers = element("section", { className: "panel", "aria-labelledby": "workers-title" });
    workers.append(sectionHeading(
      "workers-title",
      "Moving now",
      "A quiet worker can be healthy. A noisy worker can still be stale.",
    ));
    const workerList = element("div", { className: "record-list" });
    for (const worker of fixture.workers) {
      workerList.append(recordCard({
        id: worker.id,
        state: worker.state,
        label: worker.label,
        detail: worker.detail,
        action: worker.state === "healthy" ? "Continue under current responsibility" : "Review lease and reassign safely",
      }));
    }
    workers.append(workerList);

    const operations = element("section", { className: "panel", "aria-labelledby": "operations-title" });
    operations.append(sectionHeading(
      "operations-title",
      "External effects",
      "Ambiguous outcomes reconcile before retry; recovery never erases history.",
    ));
    const operationList = element("div", { className: "record-list" });
    for (const operation of fixture.operations) {
      operationList.append(recordCard({
        id: operation.id,
        state: operation.state,
        label: operation.title,
        detail: operation.detail,
        action: operation.action,
      }));
    }
    operations.append(operationList);

    section.append(workers, operations);
    return section;
  }

  function evidenceAndConnections(fixture) {
    const section = element("section", { className: "work-grid secondary-grid", "aria-label": "Evidence and connection health" });

    const evidence = element("section", { className: "panel", "aria-labelledby": "evidence-title" });
    evidence.append(sectionHeading(
      "evidence-title",
      "Evidence rail",
      "References identify source objects; they do not invent progress.",
    ));
    const evidenceList = element("ul", { className: "evidence-list" });
    for (const reference of fixture.references) {
      evidenceList.append(element("li", {}, [
        element("span", { className: "source-label", text: reference.kind }),
        element("strong", { text: reference.label }),
        element("code", { text: reference.value }),
      ]));
    }
    evidence.append(evidenceList);

    const connections = element("section", { className: "panel", "aria-labelledby": "connections-title" });
    connections.append(sectionHeading(
      "connections-title",
      "Connection health",
      "Provider availability is separate from responsibility and authority.",
    ));
    const connectionList = element("div", { className: "record-list compact" });
    for (const connection of fixture.connections) {
      connectionList.append(recordCard({
        id: connection.id,
        state: connection.state,
        label: connection.label,
        detail: connection.detail,
        action: connection.state === "healthy" ? "No intervention" : "Follow the named recovery path",
      }));
    }
    connections.append(connectionList);

    section.append(evidence, connections);
    return section;
  }

  function attentionItems(fixture) {
    const items = [{
      priority: 1,
      source: "Human decision",
      id: fixture.decision.id,
      state: fixture.decision.state,
      title: fixture.decision.title,
      detail: fixture.decision.detail,
      action: "Review the exact proposal",
    }];

    for (const operation of fixture.operations) {
      if (["ambiguous", "failed", "degraded"].includes(operation.state)) {
        items.push({
          priority: operation.state === "ambiguous" ? 2 : 4,
          source: "External effect",
          id: operation.id,
          state: operation.state,
          title: operation.title,
          detail: operation.detail,
          action: operation.action,
        });
      }
    }

    for (const worker of fixture.workers) {
      if (["unhealthy", "stale", "failed"].includes(worker.state)) {
        items.push({
          priority: 3,
          source: "Worker authority",
          id: worker.id,
          state: worker.state,
          title: `${worker.label} needs attention`,
          detail: worker.detail,
          action: "Review lease and reassign safely",
        });
      }
    }

    for (const connection of fixture.connections) {
      if (connection.state !== "healthy") {
        items.push({
          priority: 5,
          source: "Connection",
          id: connection.id,
          state: connection.state,
          title: `${connection.label} is ${connection.state}`,
          detail: connection.detail,
          action: "Use the documented recovery path",
        });
      }
    }

    return items.sort((left, right) => left.priority - right.priority || codeUnitCompare(left.id, right.id));
  }

  function emptyView() {
    return element("section", { id: "attention", className: "panel empty-panel", "aria-labelledby": "empty-title" }, [
      element("p", { className: "section-kicker", text: "No active evidence" }),
      element("h2", { id: "empty-title", text: "Nothing needs attention in this preview" }),
      element("p", { text: "An empty pulse does not claim that all work is complete. It means this bounded view received no active records." }),
      element("a", { className: "text-link", href: "./", text: "Return to the fixture scenario" }),
    ]);
  }

  function renderFailure(error) {
    return element("section", { id: "attention", className: "panel error-panel", role: "alert", "aria-labelledby": "error-title" }, [
      element("p", { className: "section-kicker", text: "Preview unavailable" }),
      element("h2", { id: "error-title", text: "The local fixture could not be admitted" }),
      element("p", { text: error instanceof Error ? error.message : "The Work Pulse preview failed safely." }),
      element("a", { className: "text-link", href: "../", text: "Return to Stensibly Labs" }),
    ]);
  }

  function recordCard(record) {
    return element("article", {
      className: "record-card",
      "data-state": record.state,
      "data-record-id": record.id,
    }, [
      element("div", { className: "card-heading" }, [
        element("h3", { text: record.label }),
        stateChip(record.state),
      ]),
      element("p", { text: record.detail }),
      element("p", { className: "next-action", text: `Next: ${record.action}` }),
    ]);
  }

  function sectionHeading(id, title, description) {
    return element("div", { className: "section-heading" }, [
      element("div", {}, [
        element("p", { className: "section-kicker", text: "Evidence view" }),
        element("h2", { id, text: title }),
      ]),
      element("p", { className: "section-description", text: description }),
    ]);
  }

  function metric(label, value, detail) {
    return element("article", { className: "metric" }, [
      element("span", { className: "metric-label", text: label }),
      element("strong", { className: "metric-value", text: value }),
      element("span", { className: "metric-detail", text: detail }),
    ]);
  }

  function fact(term, value) {
    return element("div", {}, [
      element("dt", { text: term }),
      element("dd", { text: value }),
    ]);
  }

  function stateChip(state) {
    return element("span", { className: "state-chip", "data-state": state, text: state.replaceAll("_", " ") });
  }

  function element(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === undefined || value === null) continue;
      if (name === "className") node.className = value;
      else if (name === "text") node.textContent = value;
      else node.setAttribute(name, String(value));
    }
    for (const child of children) node.append(child);
    return node;
  }

  function markCurrentScenario(activeScenario) {
    const normalized = activeScenario === "default" ? "default" : activeScenario;
    document.body.setAttribute("data-scenario", normalized);
    for (const link of document.querySelectorAll("[data-scenario-link]")) {
      if (link.getAttribute("data-scenario-link") === normalized) link.setAttribute("aria-current", "page");
    }
  }

  function admitScenario(value) {
    if (value === null || value === "" || value === "default") return "default";
    if (value === "empty" || value === "degraded") return value;
    return "default";
  }

  function codeUnitCompare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function capitalize(value) {
    return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
  }
})();
