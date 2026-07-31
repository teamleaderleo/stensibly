(() => {
  const fixtureApi = globalThis.StensiblyFrontendLabFixtures;
  if (!fixtureApi) throw new Error("Studio Canvas policy requires the shared frontend labs fixture contract");
  const fixture = fixtureApi.frontendLabFixture;
  const expectedArtifactIds = Object.freeze([
    "approve-release-note",
    "worker-health",
    "repair-focus-order",
    "deploy-amber",
    "connection-health",
  ]);
  const artifactKeys = [
    "activity",
    "authority",
    "comments",
    "evidence",
    "freshness",
    "id",
    "kind",
    "nextAction",
    "owner",
    "persistence",
    "revision",
    "sections",
    "source",
    "state",
    "summary",
    "title",
    "versions",
  ];
  const versionKeys = ["content", "id", "label", "state"];

  const policy = Object.freeze({
    projectArtifacts(value) {
      const artifactValues = admitDenseDataArray(value, "Studio Canvas artifacts");
      const baseArtifacts = [];
      for (let index = 0; index < artifactValues.length; index += 1) {
        baseArtifacts.push(admitArtifact(artifactValues[index], index));
      }
      const ids = baseArtifacts.map((entry) => entry.id);
      if (new Set(ids).size !== ids.length) throw new TypeError("Studio Canvas artifact identities must be unique");
      if (ids.join(",") !== expectedArtifactIds.join(",")) {
        throw new TypeError("Studio Canvas artifacts must match the exact shared task order");
      }

      const decision = requiredRecord(fixture.decision, "decision");
      const workers = requiredRecordArray(fixture.workers, "workers", 2);
      const ready = requiredRecordArray(fixture.readyWork, "ready work", 1)
        .find((entry) => entry.id === "repair-focus-order");
      const operation = requiredRecordArray(fixture.operations, "operations", 1)
        .find((entry) => entry.id === "deploy-amber");
      const connections = requiredRecordArray(fixture.connections, "connections", 3);
      if (decision.id !== "approve-release-note" || !ready || !operation) {
        throw new TypeError("Studio Canvas fixture identities are incomplete");
      }

      return Object.freeze(baseArtifacts.map((base) => {
        if (base.id === "approve-release-note") {
          return freezeArtifact({
            ...base,
            title: requiredText(decision.title, "shared decision title"),
            summary: requiredText(decision.detail, "shared decision detail"),
            source: `Shared decision ${decision.id}`,
            sections: [
              ["Decision", requiredText(decision.detail, "shared decision detail")],
              ["Decision requested", base.sections[1]?.[1] ?? base.nextAction],
              ["Publication boundary", base.sections[2]?.[1] ?? "Fixture-only preview."],
            ],
            evidence: [requiredText(decision.id, "shared decision id"), ...base.evidence],
          });
        }
        if (base.id === "worker-health") {
          return freezeArtifact({
            ...base,
            summary: workers.map((entry) => `${requiredText(entry.label, "shared worker label")} ${requiredText(entry.state, "shared worker state")}: ${requiredText(entry.detail, "shared worker detail")}`).join(" "),
            source: "Shared worker projection",
            sections: [
              ...workers.map((entry) => [
                requiredText(entry.label, "shared worker label"),
                `${requiredText(entry.state, "shared worker state")}. ${requiredText(entry.detail, "shared worker detail")}`,
              ]),
              ["Interpretation", base.sections.at(-1)?.[1] ?? "Worker and lease state remain separate facts."],
            ],
            evidence: workers.map((entry) => requiredText(entry.id, "shared worker id")),
          });
        }
        if (base.id === "repair-focus-order") {
          return freezeArtifact({
            ...base,
            title: `Plan: ${requiredText(ready.title, "shared ready-work title")}`,
            summary: requiredText(ready.reason, "shared ready-work reason"),
            source: `Shared ready work rank ${ready.rank}`,
            evidence: [requiredText(ready.id, "shared ready-work id"), ...base.evidence],
          });
        }
        if (base.id === "deploy-amber") {
          return freezeArtifact({
            ...base,
            title: requiredText(operation.title, "shared operation title"),
            summary: requiredText(operation.detail, "shared operation detail"),
            source: `Shared operation ${operation.id}`,
            nextAction: requiredText(operation.action, "shared operation action"),
            sections: [
              ["Observed", requiredText(operation.detail, "shared operation detail")],
              ["Unknown", base.sections[1]?.[1] ?? "Remote settlement remains unknown."],
              ["Safe action", requiredText(operation.action, "shared operation action")],
            ],
            evidence: [requiredText(operation.id, "shared operation id"), ...base.evidence],
          });
        }
        return freezeArtifact({
          ...base,
          summary: connections.map((entry) => `${requiredText(entry.label, "shared connection label")} ${requiredText(entry.state, "shared connection state")}: ${requiredText(entry.detail, "shared connection detail")}`).join(" "),
          source: "Shared connection projection",
          sections: connections.map((entry) => [
            requiredText(entry.label, "shared connection label"),
            `${requiredText(entry.state, "shared connection state")}. ${requiredText(entry.detail, "shared connection detail")}`,
          ]),
          evidence: connections.map((entry) => requiredText(entry.id, "shared connection id")),
        });
      }));
    },

    commandKinds(narrow, hasComparison) {
      if (typeof narrow !== "boolean" || typeof hasComparison !== "boolean") {
        throw new TypeError("Studio Canvas command availability requires boolean layout and comparison state");
      }
      return Object.freeze([
        "artifact",
        "inspector",
        ...(hasComparison ? ["compare"] : []),
        ...(narrow ? [] : ["collapse-work", "collapse-inspector"]),
      ]);
    },

    localActionCopy(entry, action) {
      if (!entry || typeof entry !== "object") throw new TypeError("Studio Canvas selected artifact is missing");
      if (action === "source") {
        return `Source summary: ${requiredText(entry.source, "artifact source")}. Revision ${requiredText(entry.revision, "artifact revision")}. Fictional local fixture only.`;
      }
      if (action === "next") {
        return `Next action: ${requiredText(entry.nextAction, "artifact next action")}. No save, approval, submission, or write occurred.`;
      }
      throw new TypeError("Studio Canvas local action is unsupported");
    },

    usefulReturnTarget(value, body, dialog) {
      if (!value || typeof value !== "object" || value === body) return false;
      if (value.isConnected !== true || value.hidden === true || value.inert === true) return false;
      if (typeof dialog?.contains === "function" && dialog.contains(value)) return false;
      if (typeof value.hasAttribute === "function" && value.hasAttribute("disabled")) return false;
      const tagName = typeof value.tagName === "string" ? value.tagName : "";
      return Number.isInteger(value.tabIndex) && value.tabIndex >= 0
        || ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(tagName);
    },
  });

  function admitArtifact(value, index) {
    const record = admitExactDataRecord(value, artifactKeys, `Studio Canvas artifact ${index + 1}`);
    for (const key of ["id", "kind", "state", "title", "summary", "source", "revision", "freshness", "authority", "persistence", "owner", "nextAction"]) {
      record[key] = requiredText(record[key], `Studio Canvas artifact ${index + 1} ${key}`);
    }
    record.sections = admitSections(record.sections, `Studio Canvas artifact ${record.id} sections`);
    record.evidence = admitTextArray(record.evidence, `Studio Canvas artifact ${record.id} evidence`);
    record.comments = admitTextArray(record.comments, `Studio Canvas artifact ${record.id} comments`);
    record.versions = admitVersions(record.versions, `Studio Canvas artifact ${record.id} versions`);
    record.activity = admitTextArray(record.activity, `Studio Canvas artifact ${record.id} activity`);
    return freezeArtifact(record);
  }

  function admitSections(value, label) {
    const entries = admitDenseDataArray(value, label);
    const result = [];
    for (let index = 0; index < entries.length; index += 1) {
      const pair = admitDenseDataArray(entries[index], `${label} ${index + 1}`, 2);
      result.push(Object.freeze([
        requiredText(pair[0], `${label} ${index + 1} heading`),
        requiredText(pair[1], `${label} ${index + 1} copy`),
      ]));
    }
    return Object.freeze(result);
  }

  function admitTextArray(value, label) {
    const entries = admitDenseDataArray(value, label);
    const result = [];
    for (let index = 0; index < entries.length; index += 1) {
      result.push(requiredText(entries[index], `${label} ${index + 1}`));
    }
    return Object.freeze(result);
  }

  function admitVersions(value, label) {
    const entries = admitDenseDataArray(value, label);
    const result = [];
    for (let index = 0; index < entries.length; index += 1) {
      const version = admitExactDataRecord(entries[index], versionKeys, `${label} ${index + 1}`);
      result.push(Object.freeze({
        id: requiredText(version.id, `${label} ${index + 1} id`),
        state: requiredText(version.state, `${label} ${index + 1} state`),
        label: requiredText(version.label, `${label} ${index + 1} label`),
        content: requiredText(version.content, `${label} ${index + 1} content`),
      }));
    }
    return Object.freeze(result);
  }

  function admitExactDataRecord(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${label} must be an object without symbol fields`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must use a plain or null prototype`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).sort().join(",") !== keys.join(",")) {
      throw new TypeError(`${label} must use exact fields`);
    }
    const record = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${label} field ${key} must be an enumerable data property`);
      }
      record[key] = descriptor.value;
    }
    return record;
  }

  function admitDenseDataArray(value, label, exactLength = null) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${label} must be a plain array`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !("value" in lengthDescriptor)) throw new TypeError(`${label} has an invalid length descriptor`);
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) throw new TypeError(`${label} has an invalid length`);
    if (exactLength !== null && length !== exactLength) throw new TypeError(`${label} must contain exactly ${exactLength} entries`);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") throw new TypeError(`${label} cannot contain symbol fields`);
      if (key === "length") continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) throw new TypeError(`${label} contains an unsupported field`);
    }
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${label} must be a dense data array`);
      }
      result.push(descriptor.value);
    }
    return result;
  }

  function requiredRecord(value, label) {
    if (!value || typeof value !== "object" || typeof value.id !== "string") {
      throw new TypeError(`Studio Canvas shared ${label} is missing`);
    }
    return value;
  }

  function requiredRecordArray(value, label, minimum) {
    if (!Array.isArray(value) || value.length < minimum) {
      throw new TypeError(`Studio Canvas shared ${label} are incomplete`);
    }
    return value.map((entry, index) => requiredRecord(entry, `${label} ${index + 1}`));
  }

  function requiredText(value, label) {
    if (typeof value !== "string" || !value) throw new TypeError(`${label} must be non-empty text`);
    return value;
  }

  function freezeArtifact(value) {
    return Object.freeze({
      ...value,
      sections: Object.freeze(value.sections.map((entry) => Object.freeze([...entry]))),
      evidence: Object.freeze([...value.evidence]),
      comments: Object.freeze([...value.comments]),
      versions: Object.freeze([...value.versions]),
      activity: Object.freeze([...value.activity]),
    });
  }

  Object.defineProperty(globalThis, "StensiblyStudioCanvasPolicy", {
    value: policy,
    writable: false,
    enumerable: false,
    configurable: false,
  });
})();
