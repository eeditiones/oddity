import {
  ElementSpec,
  ModelNode,
  OddClipboard,
  OddClipboardState,
} from "./oddTypes";

interface WebviewPeer {
  postMessage(msg: unknown): void;
}

let clip: OddClipboard | null = null;
const peers = new Set<WebviewPeer>();

export function registerOddClipboardPeer(peer: WebviewPeer): () => void {
  peers.add(peer);
  peer.postMessage({ type: "clipState", clip: publicClip(clip) });
  return () => peers.delete(peer);
}

export function setOddClipboard(next: OddClipboard): void {
  clip =
    next.kind === "model"
      ? { kind: "model", data: cloneModel(next.data) }
      : { kind: "elementSpec", data: stripElementSpec(next.data) };
  broadcast();
}

export function getOddClipboard(): OddClipboard | null {
  if (!clip) {
    return null;
  }
  return clip.kind === "model"
    ? { kind: "model", data: cloneModel(clip.data) }
    : { kind: "elementSpec", data: stripElementSpec(clip.data) };
}

function broadcast(): void {
  const msg = { type: "clipState", clip: publicClip(clip) };
  for (const peer of peers) {
    peer.postMessage(msg);
  }
}

function publicClip(value: OddClipboard | null): OddClipboardState {
  if (!value) {
    return null;
  }
  return value.kind === "model"
    ? { kind: "model", data: cloneModel(value.data) }
    : { kind: "elementSpec", data: stripElementSpec(value.data) };
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
