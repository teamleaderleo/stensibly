export interface ToolResultSerializationFailure {
  error: {
    code: "result_serialization_failed";
    message: "Tool operation completed but its result could not be serialized";
    stage: "result_serialization";
    operationMayHaveCompleted: true;
    retryable: false;
    reconciliation: "inspect_state_before_retry";
    recommendedAction: "read_state_or_operation_receipt_before_retry";
  };
}

const serializationFailure: ToolResultSerializationFailure = {
  error: {
    code: "result_serialization_failed",
    message: "Tool operation completed but its result could not be serialized",
    stage: "result_serialization",
    operationMayHaveCompleted: true,
    retryable: false,
    reconciliation: "inspect_state_before_retry",
    recommendedAction: "read_state_or_operation_receipt_before_retry",
  },
};

const opaqueExecutionFailure = "Tool operation failed";
const maximumExecutionFailureMessageBytes = 4 * 1024;

export async function asToolResult(read: () => Promise<unknown>) {
  let value: unknown;
  try {
    value = await read();
  } catch (error) {
    return {
      content: [{
        type: "text" as const,
        text: ownDataErrorMessage(error) ?? opaqueExecutionFailure,
      }],
      isError: true,
    };
  }

  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text !== "string") throw new Error("Tool result was not JSON serializable");
    return {
      content: [{
        type: "text" as const,
        text,
      }],
    };
  } catch {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(serializationFailure, null, 2),
      }],
      isError: true,
    };
  }
}

function ownDataErrorMessage(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "message");
  } catch {
    return null;
  }
  if (
    !descriptor
    || !("value" in descriptor)
    || typeof descriptor.value !== "string"
    || descriptor.value.length === 0
  ) {
    return null;
  }
  return new TextEncoder().encode(descriptor.value).byteLength
      <= maximumExecutionFailureMessageBytes
    ? descriptor.value
    : null;
}
