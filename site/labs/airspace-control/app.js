(() => {
  const svgNS = "http://www.w3.org/2000/svg";
  const trackLayer = document.querySelector("#track-layer");
  const conflictLayer = document.querySelector("#conflict-layer");
  const selectedDetail = document.querySelector("#selected-detail");
  const selectedChip = document.querySelector("#selected-chip");
  const alerts = document.querySelector("#alerts");
  const alertCount = document.querySelector("#alert-count");
  const eventLog = document.querySelector("#event-log");
  const simClock = document.querySelector("#sim-clock");
  const crewToggle = document.querySelector("#crew-toggle");
  const resetButton = document.querySelector("#reset");
  const modeLabel = document.querySelector("#mode-label");
  const agentName = document.querySelector("#agent-name");
  const commandButtons = [...document.querySelectorAll("[data-command]")];

  const initial = [
    { id: "MANGO 7", x: 150, y: 120, heading: 35, level: 24, speed: 1.35, status: "arrival" },
    { id: "RACCOON 2", x: 625, y: 105, heading: 145, level: 25, speed: 1.2, status: "crossing" },
    { id: "VELVET 4", x: 645, y: 450, heading: 225, level: 18, speed: 1.05, status: "arrival" },
    { id: "BANANA 9", x: 185, y: 470, heading: 315, level: 19, speed: 1.15, status: "crossing" },
    { id: "MOTH 11", x: 390, y: 75, heading: 178, level: 30, speed: .95, status: "overflight" },
    { id: "SOUP 3", x: 405, y: 520, heading: 2, level: 29, speed: 1.0, status: "overflight" },
  ];

  const agents = [
    { name: "Literal Larry", line: "Instruction says resolve traffic. I picked the nearest track." },
    { name: "Ratings Goblin", line: "The center looks exciting. Sending somebody there." },
    { name: "Committee", line: "Consensus was unavailable, so I issued a temporary permanent decision." },
    { name: "Canon Debbie", line: "Preserving the existing heading felt narratively correct." },
    { name: "Panic Pivot", line: "Alert count changed. New plan." },
  ];

  let tracks = [];
  let selectedId = null;
  let chaos = false;
  let elapsed = 0;
  let lastAgentTick = 0;
  let logCounter = 0;

  function reset() {
    tracks = initial.map((item) => ({ ...item, handedOff: false, holding: false }));
    selectedId = tracks[0].id;
    chaos = false;
    elapsed = 0;
    lastAgentTick = 0;
    logCounter = 0;
    eventLog.innerHTML = "";
    crewToggle.setAttribute("aria-pressed", "false");
    crewToggle.textContent = "Release the agents";
    modeLabel.textContent = "Manual sector";
    agentName.textContent = "human desk";
    addLog("SYSTEM", "Mercury Sector reset. Six fictional tracks acquired.");
    render();
  }

  function addLog(actor, text, isAgent = false) {
    logCounter += 1;
    const item = document.createElement("li");
    const stamp = String(Math.floor(elapsed / 60)).padStart(2, "0") + ":" + String(elapsed % 60).padStart(2, "0");
    item.innerHTML = `<strong class="${isAgent ? "agent" : ""}">${escapeHtml(actor)}</strong> <span>${stamp}</span> — ${escapeHtml(text)}`;
    eventLog.prepend(item);
    while (eventLog.children.length > 16) eventLog.lastElementChild.remove();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
  }

  function selectedTrack() {
    return tracks.find((track) => track.id === selectedId) ?? null;
  }

  function issue(command, actor = "HUMAN") {
    const track = selectedTrack();
    if (!track || track.handedOff) return;
    const previous = { heading: track.heading, level: track.level };
    if (command === "left") track.heading = normalize(track.heading - 30);
    if (command === "right") track.heading = normalize(track.heading + 30);
    if (command === "climb") track.level = Math.min(40, track.level + 4);
    if (command === "descend") track.level = Math.max(8, track.level - 4);
    if (command === "hold") {
      track.heading = normalize(track.heading + 180);
      track.holding = !track.holding;
    }
    if (command === "handoff") track.handedOff = true;

    const descriptions = {
      left: `turned ${track.id} left to HDG ${String(track.heading).padStart(3, "0")}`,
      right: `turned ${track.id} right to HDG ${String(track.heading).padStart(3, "0")}`,
      climb: `moved ${track.id} from ALT ${previous.level} to ${track.level}`,
      descend: `moved ${track.id} from ALT ${previous.level} to ${track.level}`,
      hold: `${track.id} entered a highly interpretive hold`,
      handoff: `${track.id} handed off and left this desk's responsibility`,
    };
    addLog(actor, descriptions[command], actor !== "HUMAN");
    render();
  }

  function normalize(value) {
    return (value + 360) % 360;
  }

  function advance() {
    elapsed += 1;
    for (const track of tracks) {
      if (track.handedOff) continue;
      const radians = (track.heading - 90) * Math.PI / 180;
      track.x += Math.cos(radians) * track.speed * 2.4;
      track.y += Math.sin(radians) * track.speed * 2.4;
      if (track.x < 55) track.x = 745;
      if (track.x > 745) track.x = 55;
      if (track.y < 45) track.y = 555;
      if (track.y > 555) track.y = 45;
    }

    if (chaos && elapsed - lastAgentTick >= 4) {
      lastAgentTick = elapsed;
      agentMove();
    }
    render();
  }

  function agentMove() {
    const live = tracks.filter((track) => !track.handedOff);
    if (!live.length) return;
    const agent = agents[(elapsed / 4) % agents.length | 0];
    const track = live[(elapsed * 7 + logCounter) % live.length];
    const commands = ["left", "right", "climb", "descend", "hold", "handoff"];
    const command = commands[(elapsed + track.id.length + logCounter) % commands.length];
    selectedId = track.id;
    agentName.textContent = agent.name;
    addLog(agent.name, agent.line, true);
    issue(command, agent.name);
  }

  function conflicts() {
    const result = [];
    const live = tracks.filter((track) => !track.handedOff);
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i];
        const b = live[j];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const vertical = Math.abs(a.level - b.level);
        if (distance < 92 && vertical <= 3) result.push({ a, b, distance, vertical });
      }
    }
    return result;
  }

  function render() {
    const activeConflicts = conflicts();
    const conflictIds = new Set(activeConflicts.flatMap(({ a, b }) => [a.id, b.id]));
    simClock.textContent = `T+${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

    conflictLayer.innerHTML = "";
    for (const item of activeConflicts) {
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("class", "conflict-line");
      line.setAttribute("x1", item.a.x);
      line.setAttribute("y1", item.a.y);
      line.setAttribute("x2", item.b.x);
      line.setAttribute("y2", item.b.y);
      conflictLayer.appendChild(line);
    }

    trackLayer.innerHTML = "";
    for (const track of tracks) {
      if (track.handedOff) continue;
      const group = document.createElementNS(svgNS, "g");
      group.setAttribute("class", `track${track.id === selectedId ? " selected" : ""}${conflictIds.has(track.id) ? " conflict" : ""}`);
      group.setAttribute("transform", `translate(${track.x} ${track.y})`);

      const radians = (track.heading - 90) * Math.PI / 180;
      const vx = Math.cos(radians) * 34;
      const vy = Math.sin(radians) * 34;
      const vector = document.createElementNS(svgNS, "line");
      vector.setAttribute("class", "track-vector");
      vector.setAttribute("x1", "0"); vector.setAttribute("y1", "0");
      vector.setAttribute("x2", vx); vector.setAttribute("y2", vy);
      group.appendChild(vector);

      const dot = document.createElementNS(svgNS, "rect");
      dot.setAttribute("class", "track-dot");
      dot.setAttribute("x", "-4"); dot.setAttribute("y", "-4"); dot.setAttribute("width", "8"); dot.setAttribute("height", "8");
      group.appendChild(dot);

      const label = document.createElementNS(svgNS, "text");
      label.setAttribute("class", "track-label"); label.setAttribute("x", "12"); label.setAttribute("y", "-3");
      label.textContent = `${track.id}${track.id === selectedId ? " ◆" : ""}`;
      group.appendChild(label);

      const sub = document.createElementNS(svgNS, "text");
      sub.setAttribute("class", "track-sub"); sub.setAttribute("x", "12"); sub.setAttribute("y", "13");
      sub.textContent = `ALT ${track.level}  HDG ${String(Math.round(track.heading)).padStart(3, "0")}`;
      group.appendChild(sub);

      const hit = document.createElementNS(svgNS, "circle");
      hit.setAttribute("class", "track-hit"); hit.setAttribute("r", "28");
      hit.addEventListener("click", () => { selectedId = track.id; render(); });
      group.appendChild(hit);
      trackLayer.appendChild(group);
    }

    const selected = selectedTrack();
    if (selected && !selected.handedOff) {
      selectedChip.textContent = selected.id;
      selectedDetail.textContent = `${selected.status.toUpperCase()} · ALT ${selected.level} · HDG ${String(Math.round(selected.heading)).padStart(3, "0")} · ${selected.holding ? "interpretive hold" : "tracking normally"}`;
    } else {
      selectedChip.textContent = "—";
      selectedDetail.textContent = "Select a live track on the scope.";
    }
    for (const button of commandButtons) button.disabled = !selected || selected.handedOff;

    alerts.innerHTML = "";
    alertCount.textContent = String(activeConflicts.length);
    if (!activeConflicts.length) {
      const quiet = document.createElement("li");
      quiet.className = "quiet";
      quiet.textContent = "No dramatic proximity alerts. Suspiciously peaceful.";
      alerts.appendChild(quiet);
    } else {
      for (const conflict of activeConflicts) {
        const item = document.createElement("li");
        item.textContent = `${conflict.a.id} / ${conflict.b.id} — same-ish level, extremely social geometry`;
        alerts.appendChild(item);
      }
    }
  }

  crewToggle.addEventListener("click", () => {
    chaos = !chaos;
    crewToggle.setAttribute("aria-pressed", String(chaos));
    crewToggle.textContent = chaos ? "Recall the agents" : "Release the agents";
    modeLabel.textContent = chaos ? "Agent crew unleashed" : "Manual sector";
    agentName.textContent = chaos ? "rotating agent desk" : "human desk";
    addLog("SYSTEM", chaos ? "Agent crew granted the toy console. This should be educational." : "Agent crew recalled. Human desk resumed.");
  });

  resetButton.addEventListener("click", reset);
  for (const button of commandButtons) button.addEventListener("click", () => issue(button.dataset.command));

  reset();
  window.setInterval(advance, 1000);
})();
