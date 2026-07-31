import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const labsRoot = resolve(import.meta.dir, "..", "site", "labs");

test("rejects an in-root symlink whose target escapes site", async ({ request }) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "stensibly-browser-boundary-"));
  const target = join(temporaryRoot, "outside.txt");
  const link = join(labsRoot, ".browser-boundary-link.txt");
  const secret = "outside-site-target-must-never-be-served";

  await writeFile(target, secret, "utf8");
  await symlink(target, link);

  try {
    const response = await request.get("/labs/.browser-boundary-link.txt");
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain(secret);
    expect(await readFile(target, "utf8")).toBe(secret);
  } finally {
    await rm(link, { force: true });
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
