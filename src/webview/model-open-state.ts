/** Dotted index path into a spec's model tree, e.g. [1, 0] → "1.0". */
export function modelPathKey(path: number[]): string {
  return path.join(".");
}

/**
 * Which model cards are expanded, keyed by elementSpec list index and model
 * path within that spec. Lives for the webview edit session only.
 */
export class ModelOpenState {
  private bySpec = new Map<number, Set<string>>();
  onChange?: () => void;

  isOpen(specIndex: number, path: number[]): boolean {
    return this.bySpec.get(specIndex)?.has(modelPathKey(path)) ?? false;
  }

  setOpen(specIndex: number, path: number[], open: boolean): void {
    const key = modelPathKey(path);
    let set = this.bySpec.get(specIndex);
    if (open) {
      if (!set) {
        set = new Set();
        this.bySpec.set(specIndex, set);
      }
      if (set.has(key)) {
        return;
      }
      set.add(key);
    } else if (!set || !set.delete(key)) {
      return;
    } else if (set.size === 0) {
      this.bySpec.delete(specIndex);
    }
    this.onChange?.();
  }

  toggle(specIndex: number, path: number[]): void {
    this.setOpen(specIndex, path, !this.isOpen(specIndex, path));
  }

  /** Drop state for a deleted elementSpec and shift higher indices down. */
  removeSpec(specIndex: number): void {
    const next = new Map<number, Set<string>>();
    for (const [i, set] of this.bySpec) {
      if (i < specIndex) {
        next.set(i, set);
      } else if (i > specIndex) {
        next.set(i - 1, set);
      }
    }
    this.bySpec = next;
    this.onChange?.();
  }
}
