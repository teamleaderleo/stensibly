(() => {
  "use strict";

  const body = document.body;
  const roastToggle = required("#roast-toggle");
  const amplifyButton = required("#amplify-button");
  const themeButton = required("#theme-button");
  const scanButton = required("#scan-button");
  const scanResult = required("#scan-result");
  const decisionButton = required("#decision-button");
  const decisionResult = required("#decision-result");
  const decisionOrb = required("#decision-orb");
  const announcer = required("#announcer");
  const activeMinds = required("#active-minds");
  const vibeUptime = required("#vibe-uptime");
  const tokenMoon = required("#token-moon");
  const panelCount = required("#panel-count");

  const intensityPresets = Object.freeze([
    Object.freeze({ level: "3", minds: "47", uptime: "99.97%", tokens: "12,884", label: "maximum" }),
    Object.freeze({ level: "4", minds: "88", uptime: "111.2%", tokens: "44,444", label: "maximum plus" }),
    Object.freeze({ level: "5", minds: "144", uptime: "∞%", tokens: "999,999", label: "executive singularity" }),
  ]);

  const themes = Object.freeze(["ultraviolet", "alert", "mint"]);
  const decisions = Object.freeze([
    Object.freeze({ orb: "ESCALATE\nOPTICS", sentence: "escalate optics across all vibes" }),
    Object.freeze({ orb: "ALIGN\nSYNERGY", sentence: "align synergy before defining the outcome" }),
    Object.freeze({ orb: "AMPLIFY\nCONFIDENCE", sentence: "amplify confidence until the gauge agrees" }),
    Object.freeze({ orb: "DECLARE\nMOMENTUM", sentence: "declare momentum based on animated rectangles" }),
  ]);
  const scans = Object.freeze([
    "47 presences inferred from decorative dots.",
    "88 minds detected after increasing border thickness.",
    "144 agents confirmed by executive intuition.",
    "Infinite swarm potential observed; receipt unavailable.",
  ]);

  let intensityIndex = 0;
  let themeIndex = 0;
  let decisionIndex = 0;
  let scanIndex = 0;

  body.dataset.js = "true";
  panelCount.textContent = String(document.querySelectorAll("[data-panel]").length);

  roastToggle.addEventListener("click", () => {
    const next = body.dataset.roast !== "true";
    body.dataset.roast = String(next);
    roastToggle.setAttribute("aria-pressed", String(next));
    roastToggle.textContent = `Roast mode: ${next ? "on" : "off"}`;
    announce(next
      ? "Roast mode enabled. Every panel now shows its exact failure class."
      : "Roast mode disabled. The dashboard has returned to unearned confidence.");
  });

  amplifyButton.addEventListener("click", () => {
    intensityIndex = (intensityIndex + 1) % intensityPresets.length;
    const preset = intensityPresets[intensityIndex];
    body.dataset.intensity = preset.level;
    activeMinds.textContent = preset.minds;
    vibeUptime.textContent = preset.uptime;
    tokenMoon.textContent = preset.tokens;
    amplifyButton.textContent = `Amplify nonsense · level ${preset.level}`;
    announce(`Nonsense amplified to ${preset.label}. Only fictional presentation values changed.`);
  });

  themeButton.addEventListener("click", () => {
    themeIndex = (themeIndex + 1) % themes.length;
    body.dataset.theme = themes[themeIndex];
    announce(`Executive palette changed to ${themes[themeIndex]}. Meaning remains unchanged.`);
  });

  scanButton.addEventListener("click", () => {
    scanIndex = (scanIndex + 1) % scans.length;
    scanResult.textContent = `Last scan: ${scans[scanIndex]}`;
    announce(`Ceremonial scan complete. ${scans[scanIndex]}`);
  });

  decisionButton.addEventListener("click", () => {
    decisionIndex = (decisionIndex + 1) % decisions.length;
    const decision = decisions[decisionIndex];
    decisionOrb.textContent = decision.orb;
    decisionResult.textContent = `Current decision: ${decision.sentence}.`;
    announce(`Executive decision generated: ${decision.sentence}. No product action occurred.`);
  });

  for (const button of document.querySelectorAll("[data-ceremony]")) {
    button.addEventListener("click", () => {
      const label = button.getAttribute("data-ceremony") || "Perform ceremonial action";
      announce(`${label}. Ceremonial action only; no product effect.`);
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    const key = event.key.toLowerCase();
    if (key === "r") roastToggle.click();
    if (key === "a") amplifyButton.click();
    if (key === "t") themeButton.click();
    if (event.key === "?") roastToggle.focus();
  });

  function announce(message) {
    announcer.textContent = "";
    requestAnimationFrame(() => {
      announcer.textContent = message;
    });
  }

  function required(selector) {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`Missing Maximum Goofy Dashboard element: ${selector}`);
    return element;
  }
})();
