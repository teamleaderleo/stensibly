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
    button.danger { color: #b42318; }
    button:disabled { cursor: wait; opacity: 0.55; }
    textarea { width: 100%; min-height: 110px; resize: vertical; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 10px; padding: 10px; font: inherit; line-height: 1.45; background: Field; color: FieldText; }
    .status { min-height: 1.2em; font-size: 0.82rem; opacity: 0.78; }
    .error { color: #b42318; opacity: 1; }
    ul { margin: 0; padding-left: 20px; }
    a { color: LinkText; }
    code { overflow-wrap: anywhere; }
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
      let editing = false;
      let draftInstruction = "";
      let bridgeReady = false;
      let statusMessage = "";
      let statusIsError = false;
      const pending = new Map();
      const card = document.getElementById("card");

      const escapeHtml = (value) => String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

      const safeWebHref = (value) => {
        try {
          const url = new URL(String(value));
          return url.protocol === "https:" || url.protocol === "http:"
            ? escapeHtml(url.href)
            : null;
        } catch {
          return null;
        }
      };

      const evidenceHtml = (entries) => Array.isArray(entries)
        ? entries.map((entry) => {
            const href = safeWebHref(entry.uri);
            const label = escapeHtml(entry.label);
            const uri = escapeHtml(entry.uri);
            return href
              ? '<li><a href="' + href + '" target="_blank" rel="noreferrer">' + label + "</a></li>"
              : "<li>" + label + " — <code>" + uri + "</code></li>";
          }).join("")
        : "";

      const setStatus = (message, isError = false) => {
        statusMessage = message;
        statusIsError = isError;
      };

      const render = () => {
        if (!model?.continuation || !model?.sourceItem || !model?.actor) {
          card.innerHTML = "<p>Continuation data is unavailable.</p>";
          return;
        }
        const continuation = model.continuation;
        const source = model.sourceItem;
        const evidence = evidenceHtml(continuation.evidence);
        const canDecide = continuation.status === "proposed" || continuation.status === "deferred";
        const canEdit = canDecide;
        const instruction = editing
          ? '<textarea id="instruction-editor" aria-label="Continuation instruction">' + escapeHtml(draftInstruction) + "</textarea>"
          : "<p>" + escapeHtml(continuation.instruction) + "</p>";
        const editActions = editing
          ? '<button class="primary" id="save-edit" ' + (busy ? "disabled" : "") + '>Save instruction</button>' +
            '<button id="cancel-edit" ' + (busy ? "disabled" : "") + '>Cancel</button>'
          : '<button id="begin-edit" ' + (!canEdit || busy ? "disabled" : "") + '>Edit instruction</button>' +
            '<button class="primary" data-command="approve" ' + (!canDecide || busy ? "disabled" : "") + '>Continue here</button>' +
            '<button data-command="defer" ' + (continuation.status !== "proposed" || busy ? "disabled" : "") + '>Later</button>' +
            '<button class="danger" data-command="reject" ' + (!canDecide || busy ? "disabled" : "") + '>Reject</button>';

        card.innerHTML =
          "<header>" +
            "<h1>" + escapeHtml(continuation.title) + "</h1>" +
            '<div class="meta">' +
              '<span class="pill">' + escapeHtml(source.project) + "</span>" +
              '<span class="pill">' + escapeHtml(continuation.status) + "</span>" +
              '<span class="pill">generation ' + escapeHtml(continuation.generation) + "</span>" +
              (continuation.expiresAt
                ? '<span class="pill">expires ' + escapeHtml(continuation.expiresAt) + "</span>"
                : "") +
            "</div>" +
          "</header>" +
          '<section class="section"><span class="label">Why</span><p>' +
            escapeHtml(continuation.rationale) + "</p></section>" +
          '<section class="section"><span class="label">Proposed instruction</span>' +
            instruction + "</section>" +
          '<section class="section"><span class="label">Source work</span><p>' +
            escapeHtml(source.title) + "</p></section>" +
          (source.summary
            ? '<section class="section"><span class="label">Source summary</span><p>' + escapeHtml(source.summary) + "</p></section>"
            : "") +
          (evidence
            ? '<section class="section"><span class="label">Evidence</span><ul>' + evidence + "</ul></section>"
            : "") +
          '<div class="actions">' + editActions + "</div>" +
          '<p id="status" class="status' + (statusIsError ? " error" : "") + '"></p>';

        const status = document.getElementById("status");
        if (status) status.textContent = statusMessage;
        const beginEdit = document.getElementById("begin-edit");
        if (beginEdit) beginEdit.addEventListener("click", startEditing);
        const saveEditButton = document.getElementById("save-edit");
        if (saveEditButton) saveEditButton.addEventListener("click", saveEdit);
        const cancelEditButton = document.getElementById("cancel-edit");
        if (cancelEditButton) cancelEditButton.addEventListener("click", cancelEditing);
        card.querySelectorAll("button[data-command]").forEach((button) => {
          button.addEventListener("click", () => submitDecision(button.dataset.command));
        });
      };

      const bridgeRequest = (method, params) => new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("The host did not answer the widget request."));
        }, 10000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      });

      const callServerTool = async (name, args) => {
        if (bridgeReady) {
          try {
            return await bridgeRequest("tools/call", { name, arguments: args });
          } catch (error) {
            if (!window.openai?.callTool) throw error;
          }
        }
        if (window.openai?.callTool) {
          return await window.openai.callTool(name, args);
        }
        return await bridgeRequest("tools/call", { name, arguments: args });
      };

      const sendFollowUp = async (prompt) => {
        if (bridgeReady) {
          window.parent.postMessage({
            jsonrpc: "2.0",
            method: "ui/message",
            params: { content: [{ type: "text", text: prompt }] },
          }, "*");
          return;
        }
        if (window.openai?.sendFollowUpMessage) {
          await window.openai.sendFollowUpMessage({ prompt });
          return;
        }
        window.parent.postMessage({
          jsonrpc: "2.0",
          method: "ui/message",
          params: { content: [{ type: "text", text: prompt }] },
        }, "*");
      };

      const parseToolResult = (result) => {
        if (result?.isError) {
          const message = result?.content?.find((entry) => entry?.type === "text")?.text;
          throw new Error(message || "The continuation edit failed.");
        }
        if (result?.structuredContent?.id) return result.structuredContent;
        const text = result?.content?.find((entry) => entry?.type === "text")?.text;
        if (typeof text !== "string") {
          throw new Error("The continuation edit returned no readable result.");
        }
        return JSON.parse(text);
      };

      const startEditing = () => {
        if (busy || !model?.continuation) return;
        editing = true;
        draftInstruction = model.continuation.instruction;
        setStatus("");
        render();
        document.getElementById("instruction-editor")?.focus();
      };

      const cancelEditing = () => {
        if (busy) return;
        editing = false;
        draftInstruction = "";
        setStatus("");
        render();
      };

      const saveEdit = async () => {
        if (busy || !model?.continuation || !model?.actor) return;
        const textarea = document.getElementById("instruction-editor");
        const nextInstruction = String(textarea?.value ?? "").trim();
        if (!nextInstruction) {
          setStatus("Instruction cannot be empty.", true);
          render();
          return;
        }
        if (nextInstruction === model.continuation.instruction) {
          editing = false;
          draftInstruction = "";
          setStatus("Instruction is unchanged.");
          render();
          return;
        }

        const currentId = model.continuation.id;
        const currentGeneration = model.continuation.generation;
        draftInstruction = nextInstruction;
        busy = true;
        setStatus("Saving instruction…");
        render();
        try {
          const result = await callServerTool("edit_continuation", {
            id: currentId,
            actor: model.actor,
            expectedGeneration: currentGeneration,
            instruction: nextInstruction,
            note: "Edited from the ChatGPT continuation card.",
            idempotencyKey: "widget-edit-" + crypto.randomUUID(),
          });
          const updated = parseToolResult(result);
          if (
            updated?.id !== currentId
            || updated?.generation !== currentGeneration + 1
            || updated?.instruction !== nextInstruction
          ) {
            throw new Error("The proposal changed while the edit was being applied. Re-open the current server state.");
          }
          model = { ...model, continuation: updated };
          busy = false;
          editing = false;
          draftInstruction = "";
          setStatus("Instruction updated at generation " + updated.generation + ".");
          render();
        } catch (error) {
          busy = false;
          setStatus(error instanceof Error ? error.message : String(error), true);
          render();
        }
      };

      const promptFor = (command) => {
        const continuation = model.continuation;
        const actorJson = JSON.stringify(model.actor);
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

      const submitDecision = async (command) => {
        if (busy || !model) return;
        busy = true;
        setStatus("Sending your decision…");
        render();
        try {
          await sendFollowUp(promptFor(command));
          setStatus("Decision sent to the conversation.");
          render();
        } catch (error) {
          busy = false;
          setStatus(error instanceof Error ? error.message : String(error), true);
          render();
        }
      };

      const accept = (value) => {
        const structured = value?.structuredContent ?? value;
        if (structured?.kind !== "stensibly.continuation-card") return;
        if (
          model?.continuation?.id === structured.continuation?.id
          && Number(structured.continuation?.generation) < Number(model.continuation.generation)
        ) {
          return;
        }
        model = structured;
        editing = false;
        draftInstruction = "";
        render();
      };

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message?.method === "ui/initialize") {
          bridgeReady = true;
        }
        if (message?.method === "ui/notifications/tool-result") {
          bridgeReady = true;
          accept(message.params);
        }
        if (message?.id && pending.has(message.id)) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) {
            request.reject(new Error(message.error.message || "Widget request failed."));
          } else {
            request.resolve(message.result);
          }
        }
      });

      accept(window.openai?.toolOutput);
    })();
  </script>
</body>
</html>`;
