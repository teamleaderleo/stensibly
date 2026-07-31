export const FRONTEND_LABS_ENTRY = Object.freeze({
  href: '/labs/',
  eyebrow: 'Interface previews',
  title: 'Explore the new interface work.',
  description: 'Five fixture-backed interface studies are live with fictional data. They do not replace this authenticated dashboard yet.',
  action: 'Open interface previews',
});

const ENTRY_ID = 'frontend-labs-entry';
const STYLESHEET_ID = 'frontend-labs-entry-styles';
const STYLESHEET_HREF = '/frontend-labs-entry.css';

export function installFrontendLabsEntry(documentRef = globalThis.document) {
  if (!documentRef || typeof documentRef.querySelector !== 'function' || typeof documentRef.createElement !== 'function') {
    throw new TypeError('A browser document is required for the frontend Labs entry.');
  }
  if (documentRef.getElementById(ENTRY_ID)) return false;

  const shell = documentRef.querySelector('.shell');
  const topbar = documentRef.querySelector('.topbar');
  if (!shell || !topbar || typeof topbar.insertAdjacentElement !== 'function') return false;

  if (!documentRef.getElementById(STYLESHEET_ID)) {
    const stylesheet = documentRef.createElement('link');
    stylesheet.id = STYLESHEET_ID;
    stylesheet.rel = 'stylesheet';
    stylesheet.href = STYLESHEET_HREF;
    documentRef.head?.append(stylesheet);
  }

  const section = documentRef.createElement('section');
  section.id = ENTRY_ID;
  section.className = 'frontend-labs-entry';
  section.setAttribute('aria-labelledby', 'frontend-labs-entry-title');

  const copy = documentRef.createElement('div');
  copy.className = 'frontend-labs-entry-copy';

  const eyebrow = documentRef.createElement('p');
  eyebrow.className = 'frontend-labs-entry-eyebrow';
  eyebrow.textContent = FRONTEND_LABS_ENTRY.eyebrow;

  const title = documentRef.createElement('h2');
  title.id = 'frontend-labs-entry-title';
  title.textContent = FRONTEND_LABS_ENTRY.title;

  const description = documentRef.createElement('p');
  description.className = 'frontend-labs-entry-description';
  description.textContent = FRONTEND_LABS_ENTRY.description;

  const link = documentRef.createElement('a');
  link.className = 'frontend-labs-entry-action';
  link.href = FRONTEND_LABS_ENTRY.href;
  link.textContent = FRONTEND_LABS_ENTRY.action;
  link.setAttribute('aria-describedby', 'frontend-labs-entry-description');
  description.id = 'frontend-labs-entry-description';

  copy.append(eyebrow, title, description);
  section.append(copy, link);
  topbar.insertAdjacentElement('afterend', section);
  return true;
}
