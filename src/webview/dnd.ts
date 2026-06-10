import { ModelNode } from "../oddTypes";

/**
 * Drag-and-drop reordering for model lists with insertion-point semantics: the
 * dragged model is dropped into the gap *between* two cards (before or after the
 * hovered card, depending on which half the pointer is over) rather than onto a
 * card. A thin line marks the target gap.
 *
 * A single drag is in flight at a time, so source list/index and the pending
 * insertion point are tracked at module scope. Drops are only honoured within
 * the same array, so a model can't be dragged out of its list (e.g. out of a
 * modelSequence).
 */
let dragList: ModelNode[] | null = null;
let dragIndex = -1;
let insertIndex = -1;
let indicator: HTMLElement | null = null;

export function onDragStart(
  e: DragEvent,
  list: ModelNode[],
  index: number
): void {
  dragList = list;
  dragIndex = index;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    e.dataTransfer.setDragImage(e.currentTarget as HTMLElement, 0, 0);
  }
}

export function onDragOver(
  e: DragEvent,
  list: ModelNode[],
  index: number
): void {
  if (dragList !== list || dragIndex < 0) {
    return; // not a droppable target for this drag
  }
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = "move";
  }
  const el = e.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  insertIndex = before ? index : index + 1;
  mark(el, before);
}

export function onDragLeave(e: DragEvent): void {
  clearMark(e.currentTarget as HTMLElement);
}

/** Returns true when the list was reordered (caller should persist + re-render). */
export function onDrop(e: DragEvent, list: ModelNode[]): boolean {
  if (dragList !== list || dragIndex < 0 || insertIndex < 0) {
    reset();
    return false;
  }
  e.preventDefault();
  e.stopPropagation();
  const from = dragIndex;
  // Account for the gap shifting down once the item is removed from above it.
  const to = from < insertIndex ? insertIndex - 1 : insertIndex;
  reset();
  if (to === from) {
    return false; // dropped back into its own slot
  }
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return true;
}

export function onDragEnd(): void {
  reset();
}

function mark(el: HTMLElement, before: boolean): void {
  if (indicator && indicator !== el) {
    clearMark(indicator);
  }
  indicator = el;
  el.classList.toggle("drop-before", before);
  el.classList.toggle("drop-after", !before);
}

function clearMark(el: HTMLElement): void {
  el.classList.remove("drop-before", "drop-after");
  if (indicator === el) {
    indicator = null;
  }
}

function reset(): void {
  if (indicator) {
    clearMark(indicator);
  }
  dragList = null;
  dragIndex = -1;
  insertIndex = -1;
}
