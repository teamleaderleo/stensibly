import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createGmailUnattendedMountFromEnv } from "../src/gmail-unattended-worker.ts";

test("production unattended Gmail mount consumes the durable hosted outbound self-echo lookup", () => {
  const source = readFileSync(
    new URL("../src/gmail-unattended-worker.ts", import.meta.url),
    "utf8",
  );

  expect(source).toMatch(
    /ConvexMailThreadStore|getKnownOutboundProviderMessage|getDeliveryEffectByProviderMessageId/u,
  );

  const mountFactory = createGmailUnattendedMountFromEnv.toString();
  expect(mountFactory).toMatch(
    /knownOutboundProviderMessage|isKnownOutboundProviderMessage|outboundProviderMessage/u,
  );
});
