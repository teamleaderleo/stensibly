const ACTOR_KINDS = ['human', 'agent', 'service'];
const PRINCIPAL_KINDS = ['api_token', 'account'];

export function readPrincipal(payload) {
  if (!isRecord(payload) || !isRecord(payload.principal) || !isRecord(payload.capabilities)) {
    throw new TypeError('The endpoint returned an incompatible principal response.');
  }

  const principal = payload.principal;
  const capabilities = payload.capabilities;
  const kind = typeof principal.kind === 'string' ? principal.kind.trim() : '';
  if (!PRINCIPAL_KINDS.includes(kind)) throw new TypeError('The principal kind is unsupported.');
  const name = readRequiredString(principal.name, 'The principal response is missing a name.', 160);
  const workspace = readNullableString(principal.workspace, 'The principal workspace is invalid.', 160);
  const scopes = readStringList(principal.scopes, 'The principal scopes are invalid.', 40);
  const projects = principal.projects === null
    ? null
    : readStringList(principal.projects, 'The principal project boundary is invalid.', 80);
  const role = kind === 'account'
    ? readRequiredString(principal.role, 'The account principal role is invalid.', 80)
    : undefined;

  for (const key of ['read', 'write', 'admin']) {
    if (typeof capabilities[key] !== 'boolean') {
      throw new TypeError(`The principal ${key} capability is invalid.`);
    }
  }

  return {
    principal: {
      kind,
      name,
      workspace,
      ...(role === undefined ? {} : { role }),
      scopes,
      projects,
    },
    capabilities: {
      read: capabilities.read,
      write: capabilities.write,
      admin: capabilities.admin,
    },
  };
}

export function validateActor(input) {
  if (!isRecord(input)) throw new TypeError('Enter an actor ID, name, and kind.');
  const id = readRequiredString(input.id, 'Actor ID is required.', 120);
  const name = readRequiredString(input.name, 'Actor name is required.', 160);
  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  if (!ACTOR_KINDS.includes(kind)) {
    throw new TypeError('Actor kind must be human, agent, or service.');
  }
  return { id, name, kind };
}

export function readStoredActor(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return validateActor(JSON.parse(value));
  } catch {
    return null;
  }
}

export function serializeActor(input) {
  return JSON.stringify(validateActor(input));
}

export function actorKinds() {
  return [...ACTOR_KINDS];
}

function readRequiredString(value, message, maxLength) {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output) throw new TypeError(message);
  if (/stn\.tok_/i.test(output)) throw new TypeError('Credential-shaped values are not valid session context.');
  if (output.length > maxLength) throw new TypeError(`${message.replace(/\.$/, '')} (maximum ${maxLength} characters).`);
  return output;
}

function readNullableString(value, message, maxLength) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(message);
  const output = value.trim();
  if (!output || output.length > maxLength) throw new TypeError(message);
  if (/stn\.tok_/i.test(output)) throw new TypeError('Credential-shaped values are not valid session context.');
  return output;
}

function readStringList(value, message, itemMaxLength) {
  if (!Array.isArray(value)) throw new TypeError(message);
  const result = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw new TypeError(message);
    const output = entry.trim();
    if (!output || output.length > itemMaxLength) throw new TypeError(message);
    if (/stn\.tok_/i.test(output)) throw new TypeError('Credential-shaped values are not valid session context.');
    if (!result.includes(output)) result.push(output);
  }
  return result;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
