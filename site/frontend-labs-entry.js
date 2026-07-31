export const FRONTEND_LABS_ENTRY = Object.freeze({
  href: '/labs/',
  label: 'interface previews',
  description: 'Open the fixture-backed interface studies.',
});

const ENTRY_ID = 'frontend-labs-entry';

export function installFrontendLabsEntry(documentRef = globalThis.document) {
  if (!documentRef || typeof documentRef.querySelector !== 'function' || typeof documentRef.createElement !== 'function') {
    throw new TypeError('A browser document is required for the frontend Labs entry.');
  }
  if (documentRef.getElementById(ENTRY_ID)) return false;

  const topbar = documentRef.querySelector('.topbar');
  if (!topbar || typeof topbar.append !== 'function') return false;

  const link = documentRef.createElement('a');
  link.id = ENTRY_ID;
  link.className = 'github frontend-labs-link';
  link.href = FRONTEND_LABS_ENTRY.href;
  link.textContent = FRONTEND_LABS_ENTRY.label;
  link.setAttribute('aria-label', FRONTEND_LABS_ENTRY.description);

  const sourceLink = documentRef.querySelector('.topbar > .github');
  if (sourceLink && typeof sourceLink.insertAdjacentElement === 'function') {
    sourceLink.insertAdjacentElement('beforebegin', link);
  } else {
    topbar.append(link);
  }
  return true;
}
