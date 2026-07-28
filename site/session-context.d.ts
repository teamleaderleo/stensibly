export type ActorKind = 'human' | 'agent' | 'service';
export type PrincipalKind = 'api_token' | 'account';

export interface ActorSession {
  id: string;
  name: string;
  kind: ActorKind;
}

export interface PrincipalContext {
  principal: {
    kind: PrincipalKind;
    name: string;
    workspace: string | null;
    role?: string;
    scopes: string[];
    projects: string[] | null;
  };
  capabilities: {
    read: boolean;
    write: boolean;
    admin: boolean;
  };
}

export function readPrincipal(payload: unknown): PrincipalContext;
export function validateActor(input: unknown): ActorSession;
export function readStoredActor(value: unknown): ActorSession | null;
export function serializeActor(input: unknown): string;
export function actorKinds(): ActorKind[];
