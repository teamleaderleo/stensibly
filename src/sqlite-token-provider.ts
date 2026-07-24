import {
  authenticateApiToken,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "./auth.js";
import type { ApiTokenManager, CreateTokenInput } from "./token-provider.js";
import { StensiblyStore } from "./store.js";

export class SqliteTokenProvider implements ApiTokenManager {
  constructor(readonly store: StensiblyStore) {}

  async authenticate(rawToken: string) {
    return authenticateApiToken(this.store, rawToken);
  }

  async create(input: CreateTokenInput) {
    return createApiToken(this.store, input);
  }

  async list() {
    return listApiTokens(this.store);
  }

  async revoke(id: string) {
    return revokeApiToken(this.store, id);
  }
}
