(() => {
  "use strict";

  const globalName = "StensiblyWorkPulseFixtures";
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
      throw new Error("The Work Pulse fixture bridge is unavailable");
    }
    const api = descriptor.value;
    if (!api || typeof api !== "object" || !Object.isFrozen(api)) {
      throw new Error("The Work Pulse fixture bridge is incompatible");
    }
    const fixtureDescriptor = Object.getOwnPropertyDescriptor(api, "workPulseFixture");
    const parserDescriptor = Object.getOwnPropertyDescriptor(api, "parseWorkPulseFixture");
    if (!fixtureDescriptor || !("value" in fixtureDescriptor)) {
      throw new Error("The Work Pulse fixture is unavailable");
    }
    if (
      !parserDescriptor
      || !("value" in parserDescriptor)
      || typeof parserDescriptor.value !== "function"
    ) {
      throw new Error("The Work Pulse fixture parser is unavailable");
    }
    const fixture = Reflect.apply(
      parserDescriptor.value,
      undefined,
      [fixtureDescriptor.value],
    );
    if (!fixture || typeof fixture !== "object" || !Object.isFrozen(fixture)) {
      throw new Error("The Work Pulse fixture parser returned an incompatible result");
    }
    app.replaceChildren(renderWorkPulse(fixture, scenario));
    app.setAttribute("aria-busy", "false");
  } catch (error) {
    app.replaceChildren(renderFailure(error));
    app.setAttribute("aria-busy", "false");
  }

  function renderWorkPulse(fixture, activeScenario) {
    const fragment = document.createDocumentFragment();
    fragment.append(pulseHeader(fixture, activeScenario));

    if (activeScenario === "empty") {
      fragment.append(emptyView());
      return fragment;
    }

    const attemptsById = new Map(fixture.attempts.map((attempt) => [attempt.id, attempt]));
    fragment.append(summaryStrip(fixture));
    fragment.append(attentionLedger(fixture.attention, attemptsById));
    fragment.append(attemptRoster(fixture.attempts));
    fragment.append(relationAndTimeline(fixture, attemptsById));
    return fragment;
  }

  function pulseHeader(fixture, activeScenario) {
    const section = element("section", {
      className: "project-brief",
      "aria-labelledby": "pulse-title",
    });
    section.append(
      element("div", { className: "project-copy" }, [
        element("p", { className: "section-kicker", text: "Accepted fixture snapshot" }),
        element("h2", { id: "pulse-title", text: "Observed execution evidence" }),
        element("p", {
          className: "project-summary",
          text: "One literal view of attempts, authority generations, receipts, relationships, attention, and accepted events.",
        }),
      ]),
      element("dl", { className: "brief-facts" }, [
        fact("Observed", formatTimestamp(fixture.observedAt)),
        fact("Scenario", activeScenario === "default" ? "Normal" : capitalize(activeScenario)),
        fact("Authority", "Read-only evidence"),
      ]),
    );

    if (activeScenario === "degraded") {
      section.append(element("p", {
        className: "scenario-banner",
        role: "status",
        text: "Degraded preview: the last admitted snapshot remains readable, but no claim is made that provider or runner state is still current.",
      }));
    }
    return section;
  }

  function summaryStrip(fixture) {
    const active = fixture.attempts.filter((attempt) =>
      !["cancelled", "succeeded", "failed"].includes(attempt.state)
    ).length;
    const stale = fixture.attempts.filter((attempt) => attempt.polar.freshnessRing === "stale").length;
    return element("section", { className: "summary-strip", "aria-label": "Work Pulse summary" }, [
      metric("Current attempts", String(active), "Terminal and superseded attempts remain visible in the roster"),
      metric("Attention records", String(fixture.attention.length), "Only declared reasons enter the ledger"),
      metric("Stale receipts", String(stale), "Age comes from accepted receipt evidence"),
      metric("Relations", String(fixture.relations.length), "Every line has a named kind and evidence identity"),
    ]);
  }

  function attentionLedger(entries, attemptsById) {
    const section = element("section", {
      id: "attention",
      tabindex: "-1",
      className: "panel attention-panel",
      "aria-labelledby": "attention-title",
    });
    section.append(sectionHeading(
      "attention-title",
      "Attention ledger",
      "Human decisions, ambiguity, stale authority, external waits, and high-fan-out blockers only.",
    ));
    const list = element("div", { className: "attention-list" });

    for (const entry of entries) {
      const attempt = requiredAttempt(attemptsById, entry.attemptId);
      list.append(element("article", {
        className: "attention-card",
        "data-state": attempt.state,
        "data-record-id": entry.id,
      }, [
        element("div", { className: "card-heading" }, [
          element("span", { className: "source-label", text: humanize(entry.reason) }),
          stateChip(attempt.state),
        ]),
        element("h3", { text: entry.label }),
        element("p", { text: `${attempt.callsign} · ${attempt.outcomeId} · authority generation ${attempt.authorityGeneration}` }),
        element("p", { className: "next-action", text: `Next: ${entry.nextAction}` }),
        identityLine("Evidence", entry.evidence),
      ]));
    }
    section.append(list);
    return section;
  }

  function attemptRoster(attempts) {
    const section = element("section", {
      className: "panel",
      "aria-labelledby": "attempts-title",
    });
    section.append(sectionHeading(
      "attempts-title",
      "Attempt roster",
      "Callsign is session attribution. Item, run, authority generation, candidate, and receipt establish the durable identity.",
    ));
    const list = element("div", {
      className: "attempt-list",
      role: "region",
      tabindex: "0",
      "aria-label": "Attempt roster records",
    });
    for (const attempt of attempts) list.append(attemptCard(attempt));
    section.append(list);
    return section;
  }

  function attemptCard(attempt) {
    const identities = element("dl", { className: "identity-grid" }, [
      fact("Outcome", attempt.outcomeId),
      fact("Item", attempt.itemId),
      fact("Run", attempt.runId),
      fact("Authority", `generation ${attempt.authorityGeneration}`),
      fact("Phase", attempt.phase),
      fact("Receipt age", `${attempt.receiptAgeMinutes} min`),
      fact("Queue", attempt.queuePosition === null ? "not applicable" : String(attempt.queuePosition)),
      fact("Consequence", attempt.consequence),
    ]);
    const references = element("div", { className: "reference-row" }, [
      identityLine("Candidate", attempt.candidate ?? "none"),
      identityLine("Artifact", attempt.artifact ?? "none"),
      identityLine("Evidence", attempt.evidence),
    ]);

    return element("article", {
      className: "attempt-card",
      "data-state": attempt.state,
      "data-record-id": attempt.id,
    }, [
      element("div", { className: "card-heading" }, [
        element("div", {}, [
          element("p", { className: "source-label", text: attempt.profile }),
          element("h3", { text: attempt.callsign }),
        ]),
        stateChip(attempt.state),
      ]),
      identities,
      references,
      element("p", { className: "receipt-label", text: attempt.receiptLabel }),
      element("p", { className: "next-action", text: `Next: ${attempt.nextAction}` }),
    ]);
  }

  function relationAndTimeline(fixture, attemptsById) {
    const section = element("section", {
      className: "work-grid secondary-grid",
      "aria-label": "Declared work relationships and evidence timeline",
    });

    const relations = element("section", { className: "panel", "aria-labelledby": "relations-title" });
    relations.append(sectionHeading(
      "relations-title",
      "Declared work lanes",
      "No proximity guesses: every connection has a closed relation kind and an evidence record.",
    ));
    const relationList = element("div", { className: "record-list" });
    for (const relation of fixture.relations) {
      const from = requiredAttempt(attemptsById, relation.from);
      const to = requiredAttempt(attemptsById, relation.to);
      relationList.append(element("article", {
        className: "record-card",
        "data-state": from.state,
        "data-record-id": relation.id,
      }, [
        element("div", { className: "card-heading" }, [
          element("h3", { text: relation.label }),
          element("span", { className: "state-chip", text: humanize(relation.kind) }),
        ]),
        element("p", { text: `${from.callsign} → ${to.callsign}` }),
        identityLine("Evidence", relation.evidence),
      ]));
    }
    relations.append(relationList);

    const timeline = element("section", { className: "panel", "aria-labelledby": "timeline-title" });
    timeline.append(sectionHeading(
      "timeline-title",
      "Evidence scrubber",
      "Accepted events are ordered by canonical timestamps and retain their producing attempt identity.",
    ));
    const eventList = element("ol", {
      className: "timeline-list",
      tabindex: "0",
      "aria-label": "Evidence timeline records",
    });
    const events = [...fixture.events].sort((left, right) => codeUnitCompare(right.at, left.at));
    for (const event of events) {
      const attempt = requiredAttempt(attemptsById, event.attemptId);
      eventList.append(element("li", { "data-record-id": event.id }, [
        element("time", { dateTime: event.at, text: formatTimestamp(event.at) }),
        element("strong", { text: event.label }),
        element("span", { text: `${attempt.callsign} · ${humanize(event.kind)}` }),
        element("code", { text: event.evidence }),
      ]));
    }
    timeline.append(eventList);

    section.append(relations, timeline);
    return section;
  }

  function emptyView() {
    return element("section", {
      id: "attention",
      tabindex: "-1",
      className: "panel empty-panel",
      "aria-labelledby": "empty-title",
    }, [
      element("p", { className: "section-kicker", text: "No active projection" }),
      element("h2", { id: "empty-title", text: "No attempts are shown in this preview" }),
      element("p", {
        text: "An empty pulse does not mean all work completed. It means this bounded projection intentionally contains no attempt records.",
      }),
      element("a", { className: "text-link", href: "./", text: "Return to the admitted fixture" }),
    ]);
  }

  function renderFailure(error) {
    return element("section", {
      id: "attention",
      tabindex: "-1",
      className: "panel error-panel",
      role: "alert",
      "aria-labelledby": "error-title",
    }, [
      element("p", { className: "section-kicker", text: "Preview unavailable" }),
      element("h2", { id: "error-title", text: "The Work Pulse fixture could not be admitted" }),
      element("p", { text: error instanceof Error ? error.message : "The preview failed safely." }),
      element("a", { className: "text-link", href: "../", text: "Return to Stensibly Labs" }),
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

  function identityLine(label, value) {
    return element("p", { className: "identity-line" }, [
      element("span", { text: `${label}: ` }),
      element("code", { text: value }),
    ]);
  }

  function stateChip(state) {
    return element("span", {
      className: "state-chip",
      "data-state": state,
      text: humanize(state),
    });
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

  function requiredAttempt(attemptsById, id) {
    const attempt = attemptsById.get(id);
    if (!attempt) throw new Error(`Missing admitted Work Pulse attempt ${id}`);
    return attempt;
  }

  function markCurrentScenario(activeScenario) {
    document.body.setAttribute("data-scenario", activeScenario);
    for (const link of document.querySelectorAll("[data-scenario-link]")) {
      if (link.getAttribute("data-scenario-link") === activeScenario) {
        link.setAttribute("aria-current", "page");
      }
    }
  }

  function admitScenario(value) {
    if (value === null || value === "" || value === "default") return "default";
    if (value === "empty" || value === "degraded") return value;
    return "default";
  }

  function humanize(value) {
    return value.replaceAll("_", " ").replaceAll("-", " ");
  }

  function formatTimestamp(value) {
    const formatted = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value));
    return `${formatted} UTC`;
  }

  function codeUnitCompare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function capitalize(value) {
    return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
  }
})();
