import {
  redactCredentialText,
  reservationCapacityLabel,
  reservationIsFull,
} from './item-detail.js';

export function reservationSection(reservations) {
  const section = element('section', 'detail-section');
  const heading = element('h3');
  heading.textContent = `Reservations · ${reservations.length}`;
  section.append(heading);

  if (!reservations.length) {
    const empty = element('p', 'detail-empty');
    empty.textContent = 'No live reservations are attached to this item.';
    section.append(empty);
    return section;
  }

  const full = reservations.filter(reservationIsFull);
  if (full.length) {
    const summary = element('p', 'detail-reservation-summary');
    summary.textContent = `${full.length} ${full.length === 1 ? 'resource has' : 'resources have'} no remaining capacity.`;
    section.append(summary);
  }

  const list = element('ul', 'detail-reservations');
  for (const reservation of reservations) {
    const row = element('li', `detail-reservation${reservationIsFull(reservation) ? ' detail-reservation-full' : ''}`);
    const head = element('div', 'detail-reservation-head');
    const resource = element('strong');
    resource.textContent = text(reservation.resource, 'Unnamed resource');
    const mode = element('span', 'detail-reservation-mode');
    mode.textContent = text(reservation.mode, 'mode unavailable');
    head.append(resource, mode);

    const holder = element('p', 'detail-reservation-holder');
    const units = Number.isInteger(reservation.units) ? reservation.units : 0;
    holder.textContent = `Held by ${text(reservation.holderActorId, 'unknown actor')} · this item reserves ${units} ${units === 1 ? 'unit' : 'units'}`;

    const capacity = element('p', 'detail-reservation-capacity');
    capacity.textContent = reservationCapacityLabel(reservation);

    const identifier = element('code');
    identifier.textContent = text(reservation.id);
    const meta = element('span', 'detail-reservation-meta');
    meta.textContent = [
      `expires ${formatTimestamp(reservation.expiresAt) || 'at an unknown time'}`,
      formatTimestamp(reservation.updatedAt) ? `updated ${formatTimestamp(reservation.updatedAt)}` : '',
    ].filter(Boolean).join(' · ');
    row.append(head, holder, capacity, identifier, meta);
    list.append(row);
  }
  section.append(list);
  return section;
}

function formatTimestamp(value) {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? redactCredentialText(value) : date.toLocaleString();
}

function text(value, fallback = '') {
  const output = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return redactCredentialText(output);
}

function element(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  return node;
}
