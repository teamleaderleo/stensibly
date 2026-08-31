import { expect, test, type Page } from "@playwright/test";
import { consentPage } from "../src/mcp-oauth-protocol.ts";

const html = consentPage({
  clientName: "Codex",
  accountName: "Leo",
  scopes: ["read", "write", "offline_access"],
  projects: null,
  payload: "signed-request-payload",
  signature: "signed-request-signature",
});

test("submits each OAuth consent decision with one native button activation", async ({ page }) => {
  await installConsentCapture(page);
  await page.getByRole("button", { name: "Connect Codex" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-consent-submission",
    "approve:signed-request-payload:signed-request-signature",
  );

  await installConsentCapture(page);
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-consent-submission",
    "deny:signed-request-payload:signed-request-signature",
  );
});

test("submits OAuth approval from one keyboard activation", async ({ page }) => {
  await installConsentCapture(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Connect Codex" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("body")).toHaveAttribute(
    "data-consent-submission",
    "approve:signed-request-payload:signed-request-signature",
  );
});

async function installConsentCapture(page: Page): Promise<void> {
  await page.setContent(html);
  await page.locator("form").evaluateAll((forms) => {
    for (const form of forms) {
      if (!(form instanceof HTMLFormElement)) {
        continue;
      }
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const data = new FormData(form);
        document.body.dataset.consentSubmission = [
          data.get("decision"),
          data.get("request"),
          data.get("signature"),
        ].join(":");
      });
    }
  });
}
