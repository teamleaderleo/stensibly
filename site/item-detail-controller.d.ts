export interface ItemDetailController {
  reconcile(): void;
  reset(options?: { announce?: string }): void;
  close(): void;
}

export function createItemDetailController(options: {
  board: HTMLElement;
  getConnection(): { endpoint: string; token: string; connected: boolean };
  getItems(): Array<{ id?: string }>;
}): ItemDetailController;
