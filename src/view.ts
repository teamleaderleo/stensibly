import type { Item, ItemStatus } from "./store.ts";

const columns: Array<{ status: ItemStatus; label: string }> = [
  { status: "ready", label: "Ready" },
  { status: "active", label: "Active" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

export function renderBoard(items: Item[]): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Stensibly</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      * { box-sizing: border-box; }
      body { margin: 0; background: Canvas; color: CanvasText; }
      header { display: flex; gap: 1rem; align-items: baseline; padding: 1.25rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
      h1, h2, p { margin: 0; }
      header p { opacity: .65; }
      main { padding: 1rem; }
      form { display: grid; grid-template-columns: 1fr 9rem 8rem auto; gap: .6rem; margin-bottom: 1rem; }
      input, select, button { font: inherit; padding: .65rem .75rem; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: .45rem; background: Canvas; color: CanvasText; }
      button { cursor: pointer; }
      button:hover { background: color-mix(in srgb, CanvasText 8%, Canvas); }
      .board { display: grid; grid-template-columns: repeat(4, minmax(15rem, 1fr)); gap: .8rem; align-items: start; overflow-x: auto; }
      .column { min-height: 12rem; padding: .65rem; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: .6rem; background: color-mix(in srgb, CanvasText 3%, Canvas); }
      .column h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .08em; opacity: .65; margin-bottom: .65rem; }
      .cards { display: grid; gap: .55rem; }
      .card { padding: .75rem; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: .5rem; background: Canvas; }
      .card-head { display: flex; justify-content: space-between; gap: .5rem; }
      .kind { font-size: .7rem; opacity: .55; text-transform: uppercase; }
      .title { margin-top: .25rem; line-height: 1.35; }
      .summary, .next { margin-top: .55rem; font-family: system-ui, sans-serif; font-size: .85rem; line-height: 1.4; opacity: .75; white-space: pre-wrap; }
      .next::before { content: "next: "; font-family: ui-monospace, monospace; opacity: .65; }
      .meta { margin-top: .65rem; font-size: .72rem; opacity: .55; }
      .actions { display: flex; gap: .35rem; margin-top: .65rem; }
      .actions button { padding: .35rem .5rem; font-size: .75rem; }
      .empty { padding: .8rem; opacity: .4; font-size: .8rem; }
      @media (max-width: 760px) {
        form { grid-template-columns: 1fr 1fr; }
        form input:first-child { grid-column: 1 / -1; }
        .board { grid-template-columns: repeat(4, 17rem); }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Stensibly</h1>
      <p>where work sometimes gets done</p>
    </header>
    <main>
      <form id="new-item">
        <input name="title" required maxlength="240" placeholder="Leave something for somebody" />
        <input name="project" required value="scrapbook" pattern="[a-z0-9][a-z0-9-_]*" aria-label="Project" />
        <select name="kind" aria-label="Kind">
          <option value="task">task</option>
          <option value="finding">finding</option>
          <option value="question">question</option>
          <option value="decision">decision</option>
          <option value="handoff">handoff</option>
          <option value="note">note</option>
        </select>
        <button type="submit">Add</button>
      </form>
      <section class="board">
        ${columns.map((column) => renderColumn(column, items)).join("")}
      </section>
    </main>
    <script>
      const actorId = localStorage.stensiblyActorId ||= 'browser-' + crypto.randomUUID().slice(0, 8);
      const actor = { id: actorId, name: actorId, kind: 'human' };

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
    </script>
  </body>
</html>`;
}

function renderColumn(column: { status: ItemStatus; label: string }, items: Item[]): string {
  const matching = items.filter((item) => item.status === column.status);
  return `<section class="column">
    <h2>${column.label} · ${matching.length}</h2>
    <div class="cards">
      ${matching.length ? matching.map(renderCard).join("") : '<p class="empty">nothing here</p>'}
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

  return `<article class="card">
    <div class="card-head">
      <span class="kind">${escapeHtml(item.kind)} · ${escapeHtml(item.project)}</span>
      <span class="kind">p${item.priority}</span>
    </div>
    <p class="title">${escapeHtml(item.title)}</p>
    ${item.summary ? `<p class="summary">${escapeHtml(item.summary)}</p>` : ""}
    ${item.nextAction ? `<p class="next">${escapeHtml(item.nextAction)}</p>` : ""}
    <p class="meta">${item.claimedBy ? `held by ${escapeHtml(item.claimedBy)}` : `v${item.version}`}</p>
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </article>`;
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
