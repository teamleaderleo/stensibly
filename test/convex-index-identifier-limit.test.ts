import { describe, expect, test } from "bun:test";

const convexIdentifierLimit = 64;
const indexLiteralPattern = /(["'`])(by_[A-Za-z0-9_]+)\1/gu;

async function convexIndexIdentifiers(): Promise<Array<{ path: string; name: string }>> {
  const glob = new Bun.Glob("convex/**/*.ts");
  const identifiers: Array<{ path: string; name: string }> = [];
  for await (const path of glob.scan({ cwd: ".", onlyFiles: true })) {
    if (path.startsWith("convex/_generated/")) continue;
    const source = await Bun.file(path).text();
    for (const match of source.matchAll(indexLiteralPattern)) {
      identifiers.push({ path, name: match[2]! });
    }
  }
  return identifiers;
}

describe("Convex index identifier limits", () => {
  test("every retained by_* identifier fits the production Convex limit", async () => {
    const overlong = (await convexIndexIdentifiers())
      .filter(({ name }) => name.length > convexIdentifierLimit)
      .map(({ path, name }) => `${path}: ${name} (${name.length})`)
      .sort();
    expect(overlong).toEqual([]);
  });

  test("the deployment failures this guard targets exceed the limit", () => {
    const semanticAdmission = [
      "by_workspace_id_and_provider",
      "_and_mailbox_binding_id_and_provider_message_id",
    ].join("");
    const dispositionLane = [
      "by_workspace_id_and_provider_and_account_binding",
      "_and_mailbox_address_and_provider_thread_id_and_provider_message_id",
    ].join("");
    expect(semanticAdmission.length).toBeGreaterThan(convexIdentifierLimit);
    expect(dispositionLane.length).toBeGreaterThan(convexIdentifierLimit);
  });
});
