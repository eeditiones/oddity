import { parse } from "@xml-tools/parser";
import { buildAst, XMLElement } from "@xml-tools/ast";
import { localName, attr, visit } from "./xmlUtils";
import {
  OddModel,
  ElementSpec,
  ModelNode,
  ModelType,
  Param,
  Rendition,
} from "./oddTypes";

/**
 * Parse an ODD document's `<schemaSpec>` into the editor model. The reverse of
 * {@link serializeElementSpec}; together they round-trip the processing-model
 * subset of an ODD. Element-level `<desc>` and source ranges are captured so the
 * editor can splice individual elementSpecs back without disturbing the rest of
 * the file.
 */
export function parseOdd(text: string): OddModel {
  const { cst, tokenVector } = parse(text);
  const ast = buildAst(cst as any, tokenVector);

  let schemaSpec: XMLElement | undefined;
  visit(ast, (el) => {
    if (!schemaSpec && localName(el.name) === "schemaSpec") {
      schemaSpec = el;
    }
  });

  const meta = {
    title: firstTitle(ast, undefined),
    titleShort: firstTitle(ast, "short"),
    cssFile: firstRenditionSource(ast),
  } as OddModel["meta"];

  if (!schemaSpec || !schemaSpec.position) {
    return {
      meta,
      elementSpecs: [],
      elementSpecIndent: "                ",
      indentUnit: "    ",
      empty: true,
    };
  }

  meta.ident = attr(schemaSpec, "ident");
  meta.source = attr(schemaSpec, "source");
  meta.ns = attr(schemaSpec, "ns");
  meta.start = attr(schemaSpec, "start");

  const elementSpecs: ElementSpec[] = [];
  for (const child of schemaSpec.subElements) {
    if (localName(child.name) === "elementSpec") {
      elementSpecs.push(parseElementSpec(text, child));
    }
  }

  const sp = schemaSpec.position;
  // Start tag spans from the element start to the first '>' on the open tag.
  const startTagEnd = text.indexOf(">", sp.startOffset);
  const closeStart = text.lastIndexOf("</", sp.endOffset);

  const elementSpecIndent =
    elementSpecs.length && elementSpecs[0].range
      ? lineIndent(text, elementSpecs[0].range.start)
      : lineIndent(text, sp.startOffset) + "    ";
  const indentUnit =
    deriveIndentUnit(lineIndent(text, sp.startOffset), elementSpecIndent) ||
    "    ";

  return {
    meta,
    elementSpecs,
    metaRange: { start: sp.startOffset, end: startTagEnd + 1 },
    schemaSpecBodyEnd: closeStart >= 0 ? closeStart : sp.endOffset,
    elementSpecIndent,
    indentUnit,
  };
}

const MODEL_TYPES = new Set(["model", "modelGrp", "modelSequence"]);
const MODELLED_CHILDREN = new Set([
  "param",
  "set-param",
  "outputRendition",
  "model",
  "modelGrp",
  "modelSequence",
  "desc",
  "template",
]);

function parseElementSpec(text: string, el: XMLElement): ElementSpec {
  const models: ModelNode[] = [];
  let hasUnmodeled = false;
  for (const child of el.subElements) {
    const name = localName(child.name);
    if (MODEL_TYPES.has(name)) {
      const model = parseModel(text, child, name as ModelType);
      if (model.hasUnmodeled) {
        hasUnmodeled = true;
      }
      models.push(model);
    } else if (name !== "desc") {
      hasUnmodeled = true;
    }
  }
  const spec: ElementSpec = {
    ident: attr(el, "ident") ?? "",
    mode: attr(el, "mode"),
    desc: directDesc(el),
    models,
  };
  if (el.position) {
    spec.range = { start: el.position.startOffset, end: el.position.endOffset + 1 };
  }
  if (hasUnmodeled) {
    spec.hasUnmodeled = true;
  }
  return spec;
}

function parseModel(
  text: string,
  el: XMLElement,
  type: ModelType
): ModelNode {
  const params: Param[] = [];
  const renditions: Rendition[] = [];
  const models: ModelNode[] = [];
  let hasUnmodeled = false;

  for (const child of el.subElements) {
    const name = localName(child.name);
    if (name === "param" || name === "set-param") {
      if (!isEmptyElement(child)) {
        hasUnmodeled = true;
      }
      params.push({
        name: attr(child, "name") ?? "",
        value: attr(child, "value") ?? "",
        set: name === "set-param",
      });
    } else if (name === "outputRendition") {
      renditions.push({
        scope: attr(child, "scope"),
        css: innerXml(text, child).trim(),
      });
    } else if (MODEL_TYPES.has(name)) {
      const nested = parseModel(text, child, name as ModelType);
      if (nested.hasUnmodeled) {
        hasUnmodeled = true;
      }
      models.push(nested);
    } else if (!MODELLED_CHILDREN.has(name)) {
      hasUnmodeled = true;
    }
  }

  const sourcerend = attr(el, "useSourceRendition");
  const template = childInner(text, el, "template");

  const node: ModelNode = {
    type,
    output: attr(el, "output"),
    predicate: attr(el, "predicate"),
    behaviour: attr(el, "behaviour"),
    css: attr(el, "cssClass"),
    sourcerend: sourcerend === "true" || sourcerend === "1",
    mode: attr(el, "pb:mode"),
    desc: directDesc(el),
    template,
    params,
    renditions,
    models,
  };
  if (hasUnmodeled) {
    node.hasUnmodeled = true;
  }
  return node;
}

/** True when an element has no text content and no child elements. */
function isEmptyElement(el: XMLElement): boolean {
  if (el.subElements.length > 0) {
    return false;
  }
  return !el.textContents.some((t) => (t.text ?? "").trim().length > 0);
}

/** Text of the first direct `<desc>` child, trimmed. */
function directDesc(el: XMLElement): string | undefined {
  const desc = el.subElements.find((c) => localName(c.name) === "desc");
  if (!desc) {
    return undefined;
  }
  const text = desc.textContents.map((t) => t.text).join("").trim();
  return text || undefined;
}

/** Inner content of the first child with the given local name, verbatim. */
function childInner(
  text: string,
  el: XMLElement,
  name: string
): string | undefined {
  const child = el.subElements.find((c) => localName(c.name) === name);
  if (!child) {
    return undefined;
  }
  return innerXml(text, child);
}

/**
 * Verbatim content between an element's start and end tags. A self-closing
 * element (`<param .../>`) naturally yields "" since the leading-tag strip
 * consumes the whole element.
 */
function innerXml(text: string, el: XMLElement): string {
  if (!el.position) {
    return "";
  }
  const raw = text.slice(el.position.startOffset, el.position.endOffset + 1);
  return raw.replace(/^<[^>]*>/, "").replace(/<\/[^>]*>\s*$/, "");
}

function firstTitle(ast: any, type: "short" | undefined): string | undefined {
  let result: string | undefined;
  visit(ast, (el) => {
    if (result !== undefined || localName(el.name) !== "title") {
      return;
    }
    const t = attr(el, "type");
    if ((type === "short" && t === "short") || (!type && t !== "short")) {
      const txt = el.textContents.map((c) => c.text).join("").trim();
      if (txt) {
        result = txt;
      }
    }
  });
  return result;
}

function firstRenditionSource(ast: any): string | undefined {
  let result: string | undefined;
  visit(ast, (el) => {
    if (result === undefined && localName(el.name) === "rendition") {
      const src = attr(el, "source");
      if (src) {
        result = src;
      }
    }
  });
  return result;
}

/** Leading whitespace of the line containing the given offset. */
function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const ws = /^[ \t]*/.exec(text.slice(lineStart, offset));
  return ws ? ws[0] : "";
}

/** The extra indentation one nesting level adds, given outer and inner indents. */
function deriveIndentUnit(outer: string, inner: string): string {
  if (inner.startsWith(outer) && inner.length > outer.length) {
    return inner.slice(outer.length);
  }
  return "";
}
