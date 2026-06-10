import { ModelNode } from "../oddTypes";

/**
 * An in-webview clipboard for whole model rules, so a model can be copied from
 * one elementSpec and pasted into another. Independent of the OS clipboard (the
 * browser's text copy/paste does not apply to the form). Deep-cloned on both
 * copy and paste, so every paste is a fresh, detached copy.
 */
let clip: ModelNode | null = null;
const listeners = new Set<() => void>();

export function copyModel(model: ModelNode): void {
  clip = clone(model);
  listeners.forEach((fn) => fn());
}

/** Subscribe to clipboard changes (so paste affordances can update). Returns an unsubscribe. */
export function onClipChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A fresh clone of the clipboard model, or null when empty. */
export function pasteModel(): ModelNode | null {
  return clip ? clone(clip) : null;
}

export function hasClip(): boolean {
  return clip !== null;
}

function clone(model: ModelNode): ModelNode {
  return JSON.parse(JSON.stringify(model));
}
