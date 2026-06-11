import { ElementSpec, ModelNode, OddClipboardState } from "../oddTypes";
import { vscode } from "./vscodeApi";

/**
 * Clipboard for model rules and whole elementSpecs, stored in the extension host
 * so copy/paste works across elementSpecs and across graphical editor tabs.
 */
let clip: OddClipboardState = null;
const listeners = new Set<() => void>();

window.addEventListener("message", (e: MessageEvent) => {
  if (e.data?.type !== "clipState") {
    return;
  }
  clip = e.data.clip ?? null;
  listeners.forEach((fn) => fn());
});

export function copyModel(model: ModelNode): void {
  const data = cloneModel(model);
  clip = { kind: "model", data };
  listeners.forEach((fn) => fn());
  vscode.postMessage({ type: "copyClip", clip: { kind: "model", data } });
}

export function copyElementSpec(spec: ElementSpec): void {
  const data = stripElementSpec(spec);
  clip = { kind: "elementSpec", data };
  listeners.forEach((fn) => fn());
  vscode.postMessage({ type: "copyClip", clip: { kind: "elementSpec", data } });
}

/** Subscribe to clipboard changes (so paste affordances can update). */
export function onClipChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A fresh clone of the clipboard model, or null when empty or not a model. */
export function pasteModel(): ModelNode | null {
  if (clip?.kind !== "model") {
    return null;
  }
  return cloneModel(clip.data);
}

export function hasModelClip(): boolean {
  return clip?.kind === "model";
}

export function hasElementSpecClip(): boolean {
  return clip?.kind === "elementSpec";
}

/** Ask the host to insert the copied elementSpec into this document. */
export function pasteElementSpec(): void {
  if (clip?.kind !== "elementSpec") {
    return;
  }
  vscode.postMessage({ type: "pasteElementSpec" });
}

function cloneModel(model: ModelNode): ModelNode {
  return JSON.parse(JSON.stringify(model));
}

function stripElementSpec(spec: ElementSpec): ElementSpec {
  const { range, hasUnmodeled, ...rest } = spec;
  void range;
  void hasUnmodeled;
  return JSON.parse(JSON.stringify(rest));
}
