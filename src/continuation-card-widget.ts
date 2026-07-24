export const CONTINUATION_CARD_URI = "ui://stensibly/continuation-card-v1.html";
export const CONTINUATION_CARD_MIME_TYPE = "text/html;profile=mcp-app";

export const CONTINUATION_CARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; background: transparent; color: CanvasText; }
    main { display: grid; gap: 12px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 14px; padding: 16px; background: Canvas; }
    header { display: grid; gap: 5px; }
    h1 { margin: 0; font-size: 1.05rem; line-height: 1.3; }
    p { margin: 0; line-height: 1.45; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 0.78rem; opacity: 0.78; }
    .pill { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 999px; padding: 3px 8px; }
    .section { display: grid; gap: 5px; }
    .label { font-size: 0.76rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.7; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { appearance: none; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: 10px; padding: 9px 12px; font: inherit; font-weight: 650; cursor: pointer; background: ButtonFace; color: ButtonText; }
    button.primary { background: Highlight; color: HighlightText; border-color: Highlight; }
    button:disabled { cursor: wait; opacity: 0.55; }
    .status { min-height: 1.2em; font-size: 0.82rem; opacity: 0.78; }
    .error { color: #b42318; opacity: 1; }
    ul { margin: 0; padding-left: 20px; }
    a { color: LinkText; }
  </style>
</head>
<body>
  <main id="card" aria-live="polite">
    <p>Loading continuation…</p>
  </main>
  <script>
    (() => {
      let model = null;
      let busy = false;
      const card = document.getElementById("card");

      const escapeHtml = (value) => String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

      const render = () => {
        if (!model?.continuation || !model?.sourceItem || !model?.actor) {
          card.innerHTML = "<p>Continuation data is unavailable.</p>";
          return;
        }
        const continuation = model.continuation;
        const source = model.sourceItem;
        const evidence = Array.isArray(continuation.evidence)
          ? continuation.evidence.map((entry) => {
              const uri = escapeHtml(entry.uri);
              return '<li><a href="' + uri + '" target="_blank" rel="noreferrer">' +
                escapeHtml(entry.label) + "</a></li>";
            }).join("")
          : "";
        const canResolve = continuation.status === "proposed" || continuation.status === "deferred";
        card.innerHTML =
          "<header>" +
            "<h1>" + escapeHtml(continuation.title) + "</h1>" +
            '<div class="meta">' +
              '<span class="pill">' + escapeHtml(source.project) + "</span>" +
              '<span class="pill">' + escapeHtml(continuation.status) + "</span>" +
              '<span class="pill">generation ' + escapeHtml(continuation.generation) + "</span>" +
            "</div>" +
          "</header>" +
          '<section class="section"><span class="label">Why</span><p>' +
            escapeHtml(continuation.rationale) + "</p></section>" +
          '<section class="section"><span class="label">Proposed action</span><p>' +
            escapeHtml(continuation.instruction) + "</p></section>" +
          '<section class="section"><span class="label">Source work</span><p>' +
            escapeHtml(source.title) + "</p></section>" +
          (evidence
            ? '<section class="section"><span class="label">Evidence</span><ul>' + evidence + "</ul></section>"
            : "") +
          '<div class="actions">' +
            '<button class="primary" data-command="approve" ' + (!canResolve || busy ? "disabled" : "") + '>Continue here</button>' +
            '<button data-command="defer" ' + (continuation.status !== "proposed" || busy ? "disabled" : "") + '>Later</button>' +
            '<button data-command="reject" ' + (!canResolve || busy ? "disabled" : "") + '>Reject</button>' +
          "</div>" +
          '<p id="status" class="status"></p>';

        card.querySelectorAll("button[data-command]").forEach((button) => {
          button.addEventListener("click", () => submit(button.dataset.command));
        });
      };

      const promptFor = (command) => {
        const continuation = model.continuation;
        const actor = model.actor;
        const actorJson = JSON.stringify(actor);
        if (command === "approve") {
          return "Re-read Stensibly continuation " + continuation.id +
            " and verify it is still at generation " + continuation.generation +
            ". Resolve it with command approve using human actor " + actorJson +
            ". After approval, carry out its typed action in this conversation. Create or identify the durable resulting item, run, decision, or conversation reference, then consume the continuation with that result. If the generation is stale, explain the current server-owned state instead of retrying blindly.";
        }
        return "Re-read Stensibly continuation " + continuation.id +
          " and verify it is still at generation " + continuation.generation +
          ". Resolve it with command " + command + " using human actor " + actorJson +
          ". If the generation is stale, explain the current server-owned state instead of retrying blindly.";
      };

      const submit = async (command) => {
        if (busy || !model) return;
        busy = true;
        render();
        const status = document.getElementById("status");
        if (status) status.textContent = "Sending your decision…";
        try {
          const prompt = promptFor(command);
          if (window.openai?.sendFollowUpMessage) {
            await window.openai.sendFollowUpMessage({ prompt });
          } else {
            window.parent.postMessage({
              jsonrpc: "2.0",
              id: crypto.randomUUID(),
              method: "ui/message",
              params: { content: [{ type: "text", text: prompt }] },
            }, "*");
          }
          if (status) status.textContent = "Decision sent to the conversation.";
        } catch (error) {
          busy = false;
          render();
          const failure = document.getElementById("status");
          if (failure) {
            failure.classList.add("error");
            failure.textContent = error instanceof Error ? error.message : String(error);
          }
        }
      };

      const accept = (value) => {
        const structured = value?.structuredContent ?? value;
        if (structured?.kind === "stensibly.continuation-card") {
          model = structured;
          render();
        }
      };

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message?.method === "ui/notifications/tool-result") {
          accept(message.params);
        }
      });

      accept(window.openai?.toolOutput);
    })();
  </script>
</body>
</html>`;
