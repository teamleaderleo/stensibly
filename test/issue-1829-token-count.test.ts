import { expect, test } from "bun:test";

const root = new URL("../", import.meta.url);
const baseSha = "71bc7dbc07b55c3e8a251c38fcd4b6b0828d17a5";
const files = ["README.md", "AGENTS.md", "STENSIBLY.md"] as const;

async function countTokens(text: string): Promise<number> {
  const response = await fetch("https://tokencost.app/api/count", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, tokenizer: "o200k_base" }),
  });
  expect(response.ok).toBe(true);
  const result = (await response.json()) as {
    tokens?: unknown;
    tokenizer?: unknown;
    exact?: unknown;
  };
  expect(result.tokenizer).toBe("o200k_base");
  expect(result.exact).toBe(true);
  expect(typeof result.tokens).toBe("number");
  return result.tokens as number;
}

test("issue 1829 exact o200k_base token measurement", async () => {
  let totalBefore = 0;
  let totalAfter = 0;

  console.log("TOKEN_COUNT\tfile\tbefore\tafter\tremoved\treduction");
  for (const path of files) {
    const baseResponse = await fetch(
      `https://raw.githubusercontent.com/teamleaderleo/stensibly/${baseSha}/${path}`,
    );
    expect(baseResponse.ok).toBe(true);
    const before = await baseResponse.text();
    const after = await Bun.file(new URL(path, root)).text();
    const beforeCount = await countTokens(before);
    const afterCount = await countTokens(after);
    const removed = beforeCount - afterCount;
    const reduction = (removed / beforeCount) * 100;
    console.log(
      `TOKEN_COUNT\t${path}\t${beforeCount}\t${afterCount}\t${removed}\t${reduction.toFixed(2)}%`,
    );
    totalBefore += beforeCount;
    totalAfter += afterCount;
  }

  const removed = totalBefore - totalAfter;
  const reduction = (removed / totalBefore) * 100;
  console.log(
    `TOKEN_COUNT\tTOTAL\t${totalBefore}\t${totalAfter}\t${removed}\t${reduction.toFixed(2)}%`,
  );
  expect(totalAfter).toBeLessThan(totalBefore);
}, 60_000);
