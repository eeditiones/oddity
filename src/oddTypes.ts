/**
 * Shared data model for the graphical ODD editor. Plain data only (no imports),
 * so it can be used by both the extension host and the webview bundle.
 *
 * The shape mirrors the processing-model subset the TEI Publisher ODD editor
 * worked with: a schemaSpec of elementSpecs, each holding a tree of
 * model / modelGrp / modelSequence rules.
 */

export type ModelType = "model" | "modelGrp" | "modelSequence";

export interface Param {
  name: string;
  value: string;
  /** true → `<pb:set-param>`, false → `<param>`. */
  set: boolean;
}

export interface Rendition {
  scope?: string;
  css: string;
}

export interface ModelNode {
  type: ModelType;
  output?: string;
  predicate?: string;
  /** Only meaningful on `type === "model"`. */
  behaviour?: string;
  /** ODD attribute `cssClass`. */
  css?: string;
  /** ODD attribute `useSourceRendition`. */
  sourcerend?: boolean;
  /** ODD attribute `pb:mode`. */
  mode?: string;
  desc?: string;
  /** Inner content of `<pb:template>`, verbatim. */
  template?: string;
  params: Param[];
  renditions: Rendition[];
  /** Nested rules, for `modelGrp` / `modelSequence`. */
  models: ModelNode[];
  /** True when this rule contains markup the form does not model. */
  hasUnmodeled?: boolean;
}

export interface ElementSpec {
  ident: string;
  mode?: string;
  /** Element-level `<desc>`, preserved on round-trip. */
  desc?: string;
  models: ModelNode[];
  /** Source offset range of the whole `<elementSpec>` (host-side only). */
  range?: { start: number; end: number };
  /** True when the elementSpec holds children the form does not model. */
  hasUnmodeled?: boolean;
}

export interface OddMeta {
  ident?: string;
  source?: string;
  ns?: string;
  start?: string;
  title?: string;
  titleShort?: string;
  description?: string;
  cssFile?: string;
}

export interface OddModel {
  meta: OddMeta;
  elementSpecs: ElementSpec[];
  /** Range of the `<schemaSpec>` start tag (for editing meta attributes). */
  metaRange?: { start: number; end: number };
  /** Offset of `</schemaSpec>` (insertion point for new elementSpecs). */
  schemaSpecBodyEnd?: number;
  /** Leading indent of an `<elementSpec>` line, e.g. "                ". */
  elementSpecIndent: string;
  /** One indentation step, e.g. "    " or "\t". */
  indentUnit: string;
  /** True when the document has no `<schemaSpec>` to edit. */
  empty?: boolean;
  /** Set when the document is not well-formed XML. */
  xmlError?: string;
}

/** Behaviours offered in the dropdown; anything else lands in "custom". */
export const BEHAVIOURS = [
  "anchor",
  "alternate",
  "block",
  "body",
  "break",
  "cell",
  "document",
  "figure",
  "graphic",
  "heading",
  "index",
  "inline",
  "link",
  "list",
  "listItem",
  "metadata",
  "note",
  "omit",
  "paragraph",
  "pass-through",
  "row",
  "section",
  "table",
  "text",
  "title",
  "webcomponent",
];

/** Base output channels. */
const BASE_OUTPUTS = ["docx", "epub", "fo", "latex", "markdown", "plain", "print", "typst", "web"];

/** Output channels whose templates are XML fragments (not CDATA text). */
export const XML_TEMPLATE_OUTPUTS = ["web", "print", "epub"] as const;

/** True when a model's template should be well-formed XML, not CDATA text. */
export function isXmlTemplateOutput(output?: string): boolean {
  if (!output) {
    return true;
  }
  const base = output.startsWith("opm-") ? output.slice(4) : output;
  return (XML_TEMPLATE_OUTPUTS as readonly string[]).includes(base);
}

/** Output channels offered in the dropdown — each base channel plus its `opm-` variant. */
export const OUTPUTS = [...BASE_OUTPUTS, ...BASE_OUTPUTS.map((o) => `opm-${o}`)];

/** outputRendition scopes. */
export const SCOPES = ["before", "after"];

/** elementSpec modes. */
export const MODES = ["change", "add"];

/** In-memory clipboard payload shared across graphical editor webviews. */
export type OddClipboard =
  | { kind: "model"; data: ModelNode }
  | { kind: "elementSpec"; data: ElementSpec };

export type OddClipboardState = OddClipboard | null;

/** Messages exchanged between the webview and the extension host. */
export type HostToWebview =
  | {
      type: "load";
      model: OddModel;
      /** Select this spec after reload (e.g. following addElementSpec). */
      selectIdent?: string;
      /** True when Recompile in TEI Publisher applies to this document. */
      canRecompile?: boolean;
    }
  | { type: "clipState"; clip: OddClipboardState }
  | { type: "selectIdent"; ident?: string; index: number; modelPath?: number[] }
  /** Flush debounced field edits before the document is saved to disk. */
  | { type: "flush" }
  /** Host finished applying the latest `updateElementSpec`. */
  | { type: "editApplied"; generation: number };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "flushDone" }
  | {
      type: "updateElementSpec";
      index: number;
      spec: ElementSpec;
      /** Monotonic id so the host can drop superseded saves. */
      generation: number;
    }
  | { type: "addElementSpec"; ident?: string }
  | { type: "deleteElementSpec"; index: number }
  | { type: "updateMeta"; meta: Partial<OddMeta> }
  | { type: "copyClip"; clip: NonNullable<OddClipboardState> }
  | { type: "pasteElementSpec" }
  | { type: "findElementSpec" }
  | { type: "recompileOdd" };
