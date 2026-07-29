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

export async function asToolResult(read: () => Promise<unknown>) {
  let value: unknown;
  try {
    value = await read();
  } catch (error) {
    return {
      content: [{
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
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
