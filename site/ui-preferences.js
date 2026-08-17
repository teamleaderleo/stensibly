const THEME_KEY = 'stensiblyTheme';
const VIEW_KEY = 'stensiblyDashboardView';
const themes = new Set(['dark', 'light']);
const views = new Set(['overview', 'activity', 'work', 'system']);
const root = document.documentElement;
const themeToggle = document.querySelector('#theme-toggle');

applyTheme(readPreference(THEME_KEY, themes) || 'dark');
applyView(readPreference(VIEW_KEY, views) || 'overview', { persist: false });

themeToggle?.addEventListener('click', () => {
  applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', { persist: true });
});

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const target = event.target.closest('[data-dashboard-view-target]');
  if (!(target instanceof HTMLButtonElement)) return;
  const view = target.dataset.dashboardViewTarget;
  if (!views.has(view)) return;
  applyView(view, { persist: true });
});

function applyTheme(theme, { persist = false } = {}) {
  root.dataset.theme = themes.has(theme) ? theme : 'dark';
  if (themeToggle) {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    themeToggle.setAttribute('aria-label', `Use ${next} theme`);
    themeToggle.setAttribute('title', `Use ${next} theme`);
  }
  if (persist) writePreference(THEME_KEY, root.dataset.theme);
}

function applyView(view, { persist = false } = {}) {
  const selected = views.has(view) ? view : 'overview';
  root.dataset.dashboardView = selected;
  for (const button of document.querySelectorAll('[data-dashboard-view-target]')) {
    button.setAttribute('aria-selected', String(button.dataset.dashboardViewTarget === selected));
  }
  for (const panel of document.querySelectorAll('[data-dashboard-view-panel]')) {
    panel.hidden = panel.dataset.dashboardViewPanel !== selected;
  }
  if (persist) writePreference(VIEW_KEY, selected);
}

function readPreference(key, allowed) {
  try {
    const value = localStorage.getItem(key) || '';
    return allowed.has(value) ? value : '';
  } catch {
    return '';
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are optional; the selected in-memory view remains usable.
  }
}
