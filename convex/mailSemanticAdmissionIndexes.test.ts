import { describe, expect, test } from "vitest";
import { mailSemanticAdmissionProviderMessageIndex } from "./mailSemanticAdmissionIndexes";

describe("mail semantic admission Convex indexes", () => {
  test("provider-message identity index stays within the Convex identifier limit", () => {
    expect(mailSemanticAdmissionProviderMessageIndex).toBe(
      "by_workspace_id_provider_mailbox_binding_id_provider_message_id",
    );
    expect(mailSemanticAdmissionProviderMessageIndex.length).toBe(63);
    expect(mailSemanticAdmissionProviderMessageIndex.length).toBeLessThanOrEqual(64);
  });
});
