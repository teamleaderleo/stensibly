export interface McpSurfaceTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}

export interface McpSurfaceEfficiencyReceipt {
  readonly version: 1;
  readonly toolCount: number;
  readonly instructionChars: number;
  readonly catalogueChars: number;
  readonly wireNameChars: number;
  readonly titleChars: number;
  readonly descriptionChars: number;
  readonly inputSchemaChars: number;
  readonly outputSchemaChars: number;
  readonly annotationChars: number;
  readonly largestTools: readonly {
    readonly name: string;
    readonly chars: number;
  }[];
}

export const publishedSurfaceBudgets = Object.freeze({
  toolCount: 21,
  instructionChars: 600,
  catalogueChars: 27_000,
  descriptionChars: 1_300,
  inputSchemaChars: 15_000,
  outputSchemaChars: 7_000,
});

export function measureMcpSurface(
  tools: readonly McpSurfaceTool[],
  instructions: string,
): McpSurfaceEfficiencyReceipt {
  const largestTools = tools
    .map((tool) => ({ name: tool.name, chars: jsonChars(tool) }))
    .sort((left, right) => right.chars - left.chars || compare(left.name, right.name))
    .slice(0, 5);
  return Object.freeze({
    version: 1 as const,
    toolCount: tools.length,
    instructionChars: instructions.length,
    catalogueChars: jsonChars(tools),
    wireNameChars: tools.reduce((total, tool) => total + tool.name.length, 0),
    titleChars: sumText(tools, (tool) => tool.title),
    descriptionChars: sumText(tools, (tool) => tool.description),
    inputSchemaChars: sumJson(tools, (tool) => tool.inputSchema),
    outputSchemaChars: sumJson(tools, (tool) => tool.outputSchema),
    annotationChars: sumJson(tools, (tool) => tool.annotations),
    largestTools: Object.freeze(largestTools.map((tool) => Object.freeze(tool))),
  });
}

export function assertCompactPublishedSurface(
  receipt: McpSurfaceEfficiencyReceipt,
): void {
  const failures = Object.entries(publishedSurfaceBudgets)
    .filter(([field, maximum]) => {
      const value = receipt[field as keyof McpSurfaceEfficiencyReceipt];
      return typeof value !== "number" || value > maximum;
    })
    .map(([field, maximum]) => `${field}=${String(receipt[field as keyof McpSurfaceEfficiencyReceipt])}>${maximum}`);
  if (failures.length > 0) {
    throw new RangeError(`Published MCP surface budget exceeded: ${failures.join(", ")}`);
  }
}

function sumText(
  tools: readonly McpSurfaceTool[],
  read: (tool: McpSurfaceTool) => string | undefined,
): number {
  return tools.reduce((total, tool) => total + (read(tool)?.length ?? 0), 0);
}

function sumJson(
  tools: readonly McpSurfaceTool[],
  read: (tool: McpSurfaceTool) => unknown,
): number {
  return tools.reduce((total, tool) => total + jsonChars(read(tool)), 0);
}

function jsonChars(value: unknown): number {
  return JSON.stringify(value ?? "").length;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
