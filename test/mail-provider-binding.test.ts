import { expect, test } from "bun:test";
import { freezeMailboxBinding } from "../src/mail-provider.ts";

test("provider-neutral mailbox binding preserves the admitted address exactly", () => {
  const binding = freezeMailboxBinding({
    provider: "fake",
    accountBinding: "operator_primary",
    mailboxAddress: "CaseSensitive.Local@Example.COM",
  });

  expect(binding.mailboxAddress).toBe("CaseSensitive.Local@Example.COM");
  expect(binding.accountBinding).toBe("operator_primary");
});
