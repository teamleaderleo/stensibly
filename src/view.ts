import type { Item, ItemStatus } from "./store.ts";

const columns: Array<{ status: ItemStatus; label: string; hint: string }> = [
  { status: "ready", label: "Ready", hint: "waiting for a willing creature" },
  { status: "active", label: "Active", hint: "currently being interfered with" },
  { status: "blocked", label: "Blocked", hint: "staring into the middle distance" },
  { status: "done", label: "Done", hint: "ostensibly handled" },
];

export function renderBoard(items: Item[]): string {
  const visible = items.filter((item) => item.status !== "archived");
  const projects = [...new Set(visible.map((item) => item.project))].sort();
  const activeActors = [...new Set(
    visible
      .filter((item) => item.status === "active" && item.claimedBy)
      .map((item) => item.claimedBy as string),
  )].sort();
  const recent = [...visible]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>Stensibly · Agent scrapbook</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --bg: #0d0d0f;
        --panel: #151518;
        --panel-2: #1b1b20;
        --line: #2d2d34;
        --muted: #92929d;
        --text: #f2f2f5;
        --accent: #d8ff5f;
        --ready: #9ac7ff;
        --active: #d8ff5f;
        --blocked: #ff9a76;
        --done: #8ce0b0;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        background:
          radial-gradient(circle at 12% -20%, rgba(216, 255, 95, .11), transparent 32rem),
          radial-gradient(circle at 96% 8%, rgba(154, 199, 255, .08), transparent 28rem),
          var(--bg);
      }
      button, input, select { font: inherit; }
      button { cursor: pointer; }
      a { color: inherit; }
      .shell { max-width: 1680px; margin: 0 auto; padding: 1.25rem; }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        margin-bottom: 1rem;
      }
      .brand { display: flex; align-items: center; gap: .85rem; }
      .mark {
        display: grid;
        place-items: center;
        width: 2.7rem;
        height: 2.7rem;
        border: 1px solid #3a3a42;
        border-radius: .8rem;
        background: linear-gradient(145deg, #202027, #111114);
        color: var(--accent);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 800;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 12px 30px rgba(0,0,0,.25);
      }
      h1, h2, h3, p { margin: 0; }
      h1 { font-size: 1.18rem; letter-spacing: -.02em; }
      .tagline { margin-top: .18rem; color: var(--muted); font-size: .82rem; }
      .live {
        display: inline-flex;
        align-items: center;
        gap: .45rem;
        padding: .45rem .65rem;
        border: 1px solid var(--line);
        border-radius: 999px;
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: .72rem;
        background: rgba(21,21,24,.82);
      }
      .pulse { width: .52rem; height: .52rem; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 .2rem rgba(216,255,95,.1); }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: .7rem;
        margin-bottom: .7rem;
      }
      .metric, .agent-panel, .activity-panel, .composer, .column {
        border: 1px solid var(--line);
        background: rgba(21,21,24,.88);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
      }
      .metric { padding: .9rem 1rem; border-radius: .8rem; }
      .metric-label { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .09em; }
      .metric-value { margin-top: .28rem; font: 700 1.65rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .metric-sub { margin-top: .4rem; color: var(--muted); font-size: .73rem; }
      .upper-grid { display: grid; grid-template-columns: 1.15fr .85fr; gap: .7rem; margin-bottom: .7rem; }
      .agent-panel, .activity-panel { border-radius: .8rem; padding: .9rem; min-height: 8.5rem; }
      .panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: .75rem; }
      .panel-head h2 { font-size: .82rem; text-transform: uppercase; letter-spacing: .09em; }
      .panel-head span { color: var(--muted); font-size: .72rem; }
      .agents { display: flex; flex-wrap: wrap; gap: .55rem; }
      .agent {
        display: flex;
        align-items: center;
        gap: .55rem;
        padding: .55rem .65rem;
        border: 1px solid #34343b;
        border-radius: .65rem;
        background: var(--panel-2);
        font: .76rem ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .agent-dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--active); box-shadow: 0 0 .8rem rgba(216,255,95,.45); }
      .agent-empty { color: var(--muted); font-size: .8rem; padding: .45rem 0; }
      .activity { display: grid; gap: .48rem; }
      .activity-row {
        display: grid;
        grid-template-columns: .55rem minmax(0, 1fr) auto;
        gap: .55rem;
        align-items: center;
        color: var(--muted);
        font-size: .74rem;
      }
      .activity-row strong { color: var(--text); font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .activity-dot { width: .45rem; height: .45rem; border-radius: 50%; background: var(--status-color, var(--muted)); }
      .composer { border-radius: .8rem; padding: .75rem; margin-bottom: .7rem; }
      .composer form { display: grid; grid-template-columns: minmax(12rem, 1fr) 10rem 9rem auto; gap: .55rem; }
      input, select, .button {
        min-width: 0;
        padding: .68rem .75rem;
        border: 1px solid #393941;
        border-radius: .58rem;
        color: var(--text);
        background: #111114;
        outline: none;
      }
      input:focus, select:focus { border-color: #686874; box-shadow: 0 0 0 .18rem rgba(255,255,255,.04); }
      .button { background: var(--accent); color: #111; border-color: transparent; font-weight: 750; }
      .toolbar { display: flex; justify-content: space-between; align-items: center; gap: .8rem; margin: 1rem 0 .65rem; }
      .toolbar h2 { font-size: .9rem; }
      .toolbar-controls { display: flex; gap: .45rem; align-items: center; }
      .toolbar select, .toolbar button { padding: .48rem .62rem; font-size: .75rem; }
      .ghost { color: var(--muted); background: var(--panel); border: 1px solid var(--line); border-radius: .5rem; }
      .board { display: grid; grid-template-columns: repeat(4, minmax(17rem, 1fr)); gap: .7rem; align-items: start; overflow-x: auto; padding-bottom: .7rem; }
      .column { min-height: 17rem; padding: .65rem; border-radius: .8rem; }
      .column-head { display: flex; justify-content: space-between; gap: .7rem; align-items: flex-start; margin-bottom: .65rem; }
      .column h3 { font-size: .78rem; text-transform: uppercase; letter-spacing: .09em; }
      .column-hint { margin-top: .18rem; color: var(--muted); font-size: .68rem; }
      .count { min-width: 1.6rem; padding: .18rem .4rem; text-align: center; border-radius: 999px; color: #111; background: var(--status-color); font: 700 .72rem ui-monospace, SFMono-Regular, Menlo, monospace; }
      .cards { display: grid; gap: .55rem; }
      .card {
        position: relative;
        overflow: hidden;
        padding: .78rem;
        border: 1px solid #33333a;
        border-radius: .68rem;
        background: linear-gradient(155deg, #1c1c21, #151519 70%);
      }
      .card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--status-color); opacity: .8; }
      .card-head { display: flex; justify-content: space-between; gap: .5rem; }
      .kind, .priority { color: var(--muted); font: .66rem ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; letter-spacing: .06em; }
      .title { margin-top: .34rem; line-height: 1.35; font-size: .88rem; font-weight: 610; }
      .summary, .next { margin-top: .5rem; color: #b6b6bf; font-size: .76rem; line-height: 1.42; white-space: pre-wrap; }
      .next { padding-left: .58rem; border-left: 1px solid #414149; }
      .next::before { content: "next · "; color: var(--status-color); font: .66rem ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
      .meta { display: flex; justify-content: space-between; gap: .6rem; margin-top: .65rem; color: var(--muted); font: .66rem ui-monospace, SFMono-Regular, Menlo, monospace; }
      .lease.urgent { color: var(--blocked); }
      .actions { display: flex; gap: .35rem; margin-top: .65rem; }
      .actions button { padding: .38rem .5rem; border: 1px solid #3a3a42; border-radius: .45rem; color: var(--text); background: #111114; font-size: .68rem; }
      .actions button:hover { border-color: #666672; }
      .empty { padding: 1.2rem .6rem; text-align: center; color: #686871; font: .72rem ui-monospace, SFMono-Regular, Menlo, monospace; }
      [hidden] { display: none !important; }
      @media (max-width: 980px) {
        .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .upper-grid { grid-template-columns: 1fr; }
        .composer form { grid-template-columns: 1fr 1fr; }
        .composer input:first-child { grid-column: 1 / -1; }
        .board { grid-template-columns: repeat(4, 18rem); }
      }
      @media (max-width: 560px) {
        .shell { padding: .8rem; }
        .topbar { align-items: center; }
        .tagline { max-width: 14rem; }
        .composer form { grid-template-columns: 1fr; }
        .composer input:first-child { grid-column: auto; }
        .toolbar { align-items: flex-start; }
        .toolbar-controls { flex-wrap: wrap; justify-content: flex-end; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="mark">S</div>
          <div>
            <h1>Stensibly</h1>
            <p class="tagline">where work sometimes gets done and sometimes goes catastrophically off the rails</p>
          </div>
        </div>
        <div class="live"><span class="pulse"></span><span id="live-label">ledger live</span></div>
      </header>

      <section class="summary-grid" aria-label="Work totals">
        ${renderMetric("Ready", countStatus(visible, "ready"), "available for pickup")}
        ${renderMetric("Active", countStatus(visible, "active"), `${activeActors.length} actor${activeActors.length === 1 ? "" : "s"} roaming`)}
        ${renderMetric("Blocked", countStatus(visible, "blocked"), "awaiting intervention")}
        ${renderMetric("Done", countStatus(visible, "done"), "somehow survived")}
      </section>

      <section class="upper-grid">
        <section class="agent-panel">
          <div class="panel-head"><h2>Agents in the walls</h2><span>${activeActors.length} currently visible</span></div>
          <div class="agents">
            ${activeActors.length
              ? activeActors.map((actor) => `<div class="agent"><span class="agent-dot"></span>${escapeHtml(actor)}</div>`).join("")
              : '<p class="agent-empty">quiet. suspiciously quiet.</p>'}
          </div>
        </section>
        <section class="activity-panel">
          <div class="panel-head"><h2>Recent movement</h2><span>latest item updates</span></div>
          <div class="activity">
            ${recent.length ? recent.map(renderActivity).join("") : '<p class="agent-empty">no footprints yet</p>'}
          </div>
        </section>
      </section>

      <section class="composer">
        <form id="new-item">
          <input name="title" required maxlength="240" placeholder="Leave something for somebody" />
          <input name="project" required value="${escapeHtml(projects[0] ?? "scrapbook")}" pattern="[a-z0-9][a-z0-9-_]*" aria-label="Project" />
          <select name="kind" aria-label="Kind">
            <option value="task">task</option>
            <option value="finding">finding</option>
            <option value="question">question</option>
            <option value="decision">decision</option>
            <option value="tip">tip</option>
            <option value="handoff">handoff</option>
            <option value="note">note</option>
          </select>
          <button class="button" type="submit">Leave it here</button>
        </form>
      </section>

      <section class="toolbar">
        <div><h2>Work in motion</h2></div>
        <div class="toolbar-controls">
          <select id="project-filter" aria-label="Filter by project">
            <option value="">all projects</option>
            ${projects.map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`).join("")}
          </select>
          <button class="ghost" id="refresh" type="button">refresh</button>
          <button class="ghost" id="auto-refresh" type="button" aria-pressed="true">auto · on</button>
        </div>
      </section>

      <section class="board">
        ${columns.map((column) => renderColumn(column, visible)).join("")}
      </section>
    </main>
    <script>
      const actorId = localStorage.stensiblyActorId ||= 'browser-' + crypto.randomUUID().slice(0, 8);
      const actor = { id: actorId, name: actorId, kind: 'human' };
      const projectFilter = document.querySelector('#project-filter');
      const autoButton = document.querySelector('#auto-refresh');
      let autoRefresh = sessionStorage.stensiblyAutoRefresh !== 'off';
      let refreshTimer;

      async function request(path, body) {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
      }

      function applyProjectFilter() {
        const project = projectFilter.value;
        document.querySelectorAll('[data-project]').forEach((card) => {
          card.hidden = Boolean(project && card.dataset.project !== project);
        });
        document.querySelectorAll('[data-column]').forEach((column) => {
          const visible = [...column.querySelectorAll('[data-project]')].filter((card) => !card.hidden).length;
          column.querySelector('[data-count]').textContent = String(visible);
          const empty = column.querySelector('[data-empty]');
          if (empty) empty.hidden = visible > 0;
        });
      }

      function updateTimes() {
        const now = Date.now();
        document.querySelectorAll('[data-time]').forEach((node) => {
          const time = Date.parse(node.dataset.time);
          if (!Number.isFinite(time)) return;
          const seconds = Math.max(0, Math.floor((now - time) / 1000));
          node.textContent = seconds < 60 ? seconds + 's ago' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago' : seconds < 86400 ? Math.floor(seconds / 3600) + 'h ago' : Math.floor(seconds / 86400) + 'd ago';
        });
        document.querySelectorAll('[data-expires]').forEach((node) => {
          const remaining = Date.parse(node.dataset.expires) - now;
          node.classList.toggle('urgent', remaining > 0 && remaining < 120000);
          node.textContent = remaining <= 0 ? 'lease expired' : 'lease ' + (remaining < 60000 ? Math.ceil(remaining / 1000) + 's' : Math.ceil(remaining / 60000) + 'm');
        });
      }

      function configureAutoRefresh() {
        clearInterval(refreshTimer);
        autoButton.textContent = autoRefresh ? 'auto · on' : 'auto · off';
        autoButton.setAttribute('aria-pressed', String(autoRefresh));
        sessionStorage.stensiblyAutoRefresh = autoRefresh ? 'on' : 'off';
        if (autoRefresh) refreshTimer = setInterval(() => {
          if (!document.hidden && !document.querySelector('#new-item input[name=title]').value) location.reload();
        }, 20000);
      }

      document.querySelector('#new-item').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        try {
          await request('/api/items', {
            title: form.get('title'),
            project: form.get('project'),
            kind: form.get('kind'),
            actor,
          });
          location.reload();
        } catch (error) {
          alert(error.message);
        }
      });

      document.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        button.disabled = true;
        try {
          const id = button.dataset.id;
          const action = button.dataset.action;
          const body = action === 'claim' ? { actor, leaseSeconds: 900 } : { actor };
          await request('/api/items/' + encodeURIComponent(id) + '/' + action, body);
          location.reload();
        } catch (error) {
          button.disabled = false;
          alert(error.message);
        }
      });

      projectFilter.addEventListener('change', applyProjectFilter);
      document.querySelector('#refresh').addEventListener('click', () => location.reload());
      autoButton.addEventListener('click', () => { autoRefresh = !autoRefresh; configureAutoRefresh(); });
      updateTimes();
      applyProjectFilter();
      configureAutoRefresh();
      setInterval(updateTimes, 1000);
    </script>
  </body>
</html>`;
}

function countStatus(items: Item[], status: ItemStatus): number {
  return items.filter((item) => item.status === status).length;
}

function renderMetric(label: string, value: number, sub: string): string {
  return `<article class="metric">
    <p class="metric-label">${escapeHtml(label)}</p>
    <p class="metric-value">${value}</p>
    <p class="metric-sub">${escapeHtml(sub)}</p>
  </article>`;
}

function renderActivity(item: Item): string {
  return `<div class="activity-row" style="--status-color:${statusColor(item.status)}">
    <span class="activity-dot"></span>
    <strong>${escapeHtml(item.title)}</strong>
    <span data-time="${escapeHtml(item.updatedAt)}">${escapeHtml(item.project)}</span>
  </div>`;
}

function renderColumn(
  column: { status: ItemStatus; label: string; hint: string },
  items: Item[],
): string {
  const matching = items.filter((item) => item.status === column.status);
  return `<section class="column" data-column="${column.status}" style="--status-color:${statusColor(column.status)}">
    <header class="column-head">
      <div><h3>${column.label}</h3><p class="column-hint">${column.hint}</p></div>
      <span class="count" data-count>${matching.length}</span>
    </header>
    <div class="cards">
      ${matching.map(renderCard).join("")}
      <p class="empty" data-empty${matching.length ? " hidden" : ""}>nothing here</p>
    </div>
  </section>`;
}

function renderCard(item: Item): string {
  const actions =
    item.status === "ready"
      ? button("claim", "claim", item.id)
      : item.status === "active"
        ? `${button("complete", "complete", item.id)}${button("release", "release", item.id)}`
        : "";

  const lease = item.claimExpiresAt
    ? `<span class="lease" data-expires="${escapeHtml(item.claimExpiresAt)}">lease</span>`
    : `<span>v${item.version}</span>`;

  return `<article class="card" data-project="${escapeHtml(item.project)}" style="--status-color:${statusColor(item.status)}">
    <div class="card-head">
      <span class="kind">${escapeHtml(item.kind)} · ${escapeHtml(item.project)}</span>
      <span class="priority">p${item.priority}</span>
    </div>
    <p class="title">${escapeHtml(item.title)}</p>
    ${item.summary ? `<p class="summary">${escapeHtml(item.summary)}</p>` : ""}
    ${item.nextAction ? `<p class="next">${escapeHtml(item.nextAction)}</p>` : ""}
    <p class="meta"><span>${item.claimedBy ? `held by ${escapeHtml(item.claimedBy)}` : `<span data-time="${escapeHtml(item.updatedAt)}">updated</span>`}</span>${lease}</p>
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </article>`;
}

function statusColor(status: ItemStatus): string {
  switch (status) {
    case "ready": return "var(--ready)";
    case "active": return "var(--active)";
    case "blocked": return "var(--blocked)";
    case "done": return "var(--done)";
    default: return "var(--muted)";
  }
}

function button(action: string, label: string, id: string): string {
  return `<button type="button" data-action="${action}" data-id="${escapeHtml(id)}">${label}</button>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}
