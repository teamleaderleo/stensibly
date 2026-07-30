import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../site/app.js", import.meta.url), "utf8");

describe("dashboard connection-state contract", () => {
  test("ships every disconnected child that the renderer updates", () => {
    expect(html).toContain('<section class="disconnected" id="disconnected-state">');
    expect(html).toContain("<p>Sign in to continue.</p>");
    expect(html).toContain(
      "<span>Continue with GitHub, or use the advanced connection for another endpoint.</span>",
    );
    expect(app).toContain("disconnected.querySelector('p').textContent");
    expect(app).toContain("disconnected.querySelector('span').textContent");
  });

  test("describes bearer-token retention as browser-session scoped", () => {
    expect(html).toContain(
      "A bearer token stays in this browser session and is cleared when the session ends.",
    );
    expect(html).not.toContain("Tokens are not saved.");
    expect(app).toContain("const browserSessionStorage = optionalSessionStorage()");
    expect(app).toContain("writeSessionValue('stensiblyToken', token)");
    expect(app).toContain("removeSessionValue('stensiblyToken')");
  });

  test("keeps ordinary and malformed-token startup on the signed-out path", () => {
    expect(app).toContain("if (token && isPlausibleToken(token)) {");
    expect(app).toContain("if (token) clearStoredToken();");
    expect(app).toContain("showConnectionForm();");
  });

  test("returns failed initial terminal connections to recovery copy", () => {
    expect(app).toContain("if (isTerminalConnectionFailure(error)) {");
    expect(app).toContain("connected = false;");
    expect(app).toContain("showConnectionForm(message);");
    expect(app).toContain("disconnected.hidden = false;");
  });

  test("allows authenticated connection editing to cancel back to the dashboard", () => {
    expect(app).toContain(
      "showConnectionForm('', { keepDashboard: true, allowCancel: true });",
    );
    expect(app).toContain("function cancelConnectionChange() {");
    expect(app).toContain("if (!connected) return;");
    expect(app).toContain("showConnectedState();");
    expect(app).toContain("dashboard.hidden = false;");
    expect(app).toContain("disconnected.hidden = true;");
  });
});
