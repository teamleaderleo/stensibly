export async function asToolResult(read: () => Promise<unknown>) {
  try {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(await read(), null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      }],
      isError: true,
    };
  }
}
