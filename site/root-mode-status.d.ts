export type RootAppMode = "signed-out" | "connecting" | "connected" | "degraded" | "editing";

export interface RootModeStatusElement {
  dataset: DOMStringMap;
  setAttribute(name: string, value: string): void;
}

export interface RootModeElement {
  dataset: DOMStringMap;
}

export interface RootModeObserver {
  observe(target: RootModeElement, options: MutationObserverInit): void;
  disconnect(): void;
}

export interface RootModeObserverConstructor {
  new (callback: () => void): RootModeObserver;
}

export function applyRootModeStatus(
  status: RootModeStatusElement,
  mode: RootAppMode | string | undefined,
): boolean;

export function installRootModeStatus(input: {
  root: RootModeElement;
  status: RootModeStatusElement;
  MutationObserverImpl?: RootModeObserverConstructor | null;
}): RootModeObserver;
