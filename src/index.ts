import { createApp } from "./app.ts";
import { StensiblyStore } from "./store.ts";

const port = Number(Bun.env.PORT ?? 3000);
const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
const store = new StensiblyStore(databasePath);
const app = createApp(store);

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Stensibly is loitering at http://localhost:${port}`);
console.log(`Database: ${databasePath}`);
