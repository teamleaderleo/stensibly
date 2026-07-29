import { createProviderCapacityController } from './provider-capacity-controller.js';

const DEFAULT_ENDPOINT = 'https://api.stensibly.com';
const TOKEN_STORAGE_KEY = 'stensiblyToken';
const ENDPOINT_STORAGE_KEY = 'stensiblyEndpoint';

export function installProviderCapacityCard() {
  const metrics = document.querySelector('.metrics');
  const dashboard = document.querySelector('#dashboard');
  const lastUpdated = document.querySelector('#last-updated');
  const connectionState = document.querySelector('#connection-state');
  if (!metrics || !dashboard || !lastUpdated || !connectionState) return null;
  if (document.querySelector('#provider-capacity-panel')) return null;

  installStylesheet();
  metrics.insertAdjacentHTML('beforebegin', panelMarkup());

  const controller = createProviderCapacityController({
    getConnection: () => ({
      endpoint: storedEndpoint(),
      token: storedToken(),
      connected: !dashboard.hidden && Boolean(storedToken()),
    }),
    reportConnectionIssue: () => {},
  });
  const observer = new MutationObserver(() => void controller.refresh());
  observer.observe(lastUpdated, { childList: true, characterData: true, subtree: true });
  observer.observe(connectionState, { childList: true, characterData: true, subtree: true });
  queueMicrotask(() => void controller.refresh());
  return { controller, disconnect: () => observer.disconnect() };
}

function storedEndpoint() {
  try {
    const value = String(localStorage.getItem(ENDPOINT_STORAGE_KEY) || DEFAULT_ENDPOINT).trim();
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash
      ? parsed.origin
      : DEFAULT_ENDPOINT;
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

function storedToken() {
  try {
    return String(sessionStorage.getItem(TOKEN_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function installStylesheet() {
  if (document.querySelector('link[href="/provider-capacity.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/provider-capacity.css';
  document.head.append(link);
}

function panelMarkup() {
  return `<section class="provider-capacity" id="provider-capacity-panel" data-state="unknown" aria-labelledby="provider-capacity-title">
    <div class="provider-capacity-head">
      <div>
        <p class="eyebrow">Review capacity</p>
        <h3 id="provider-capacity-title">CodeRabbit preflight</h3>
      </div>
      <span id="provider-capacity-status" role="status">scope needed</span>
    </div>
    <form class="provider-capacity-form" id="provider-capacity-form">
      <label>
        Repository
        <input name="repository" required maxlength="200" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="owner/repository" />
      </label>
      <label>
        Developer subject
        <input name="subject" required maxlength="120" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="GitHub login" />
      </label>
      <button type="submit">read capacity</button>
      <button class="secondary" id="provider-capacity-clear" type="button" hidden>clear scope</button>
    </form>
    <p id="provider-capacity-scope">Choose the repository and developer subject whose quota observation should be shown.</p>
    <div class="provider-capacity-details" id="provider-capacity-details" hidden>
      <div><span>Quota</span><strong id="provider-capacity-quota"></strong></div>
      <div><span>Timing</span><strong id="provider-capacity-timing"></strong></div>
      <div><span>Observation</span><strong id="provider-capacity-observed"></strong></div>
      <div><span>Source</span><a id="provider-capacity-source" target="_blank" rel="noreferrer"></a></div>
    </div>
    <p class="provider-capacity-error" id="provider-capacity-error" role="alert" hidden></p>
    <p class="provider-capacity-note">Read-only. This card never posts a quota query or requests a review. Automatic reviews may consume capacity after the last observation.</p>
  </section>`;
}
