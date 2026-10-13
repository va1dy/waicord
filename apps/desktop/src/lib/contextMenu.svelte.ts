export type MenuItem = {
  label: string;
  hint?: string;
  disabled?: boolean;
  run?: () => void;
};

class ContextMenuState {
  open = $state(false);
  items = $state<MenuItem[]>([]);
  anchor = $state({ x: 0, y: 0 });

  show(e: MouseEvent, items: MenuItem[]): void {
    if (items.length === 0) {
      this.hide();
      return;
    }
    this.items = items;
    this.anchor = { x: e.clientX, y: e.clientY };
    this.open = true;
  }

  hide(): void {
    this.open = false;
  }

  select(item: MenuItem): void {
    if (item.disabled) return;
    this.hide();
    item.run?.();
  }
}

export const contextMenu = new ContextMenuState();
