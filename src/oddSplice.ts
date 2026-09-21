import { parse } from "@xml-tools/parser";
import { buildAst, XMLElement } from "@xml-tools/ast";
import { MODEL_TYPES, parseModels } from "./oddModel";
import { ElementSpec } from "./oddTypes";
import {
  serializeElementSpec,
  serializeModel,
  serializeModels,
} from "./oddSerialize";
import { escapeXmlAttr, localName } from "./xmlUtils";

/**
 * Rewrite an existing `<elementSpec>` in place instead of regenerating it.
 *
 * The form owns exactly two things: the `ident` / `mode` attributes and the
 * tree of `model` / `modelGrp` / `modelSequence` rules. Everything else in the
 * element — `attList`, `content`, `classes`, `constraintSpec`, `desc`,
 * `remarks`, comments, and attributes the form doesn't know about — is carried
 * over from `raw` byte for byte. {@link serializeElementSpec} is the whole-cloth
 * counterpart, used when there is no source to preserve (new or pasted specs).
 *
 * Within the run of rules the same idea applies one level down: a rule that
 * still serializes the way its source did is written back from the source, so
 * only the rule the user actually edited is regenerated.
 *
 * `raw` is the exact source slice of the element, from `<elementSpec` through
 * its closing tag; `indent` is the leading whitespace of its line and prefixes
 * the result, matching {@link serializeElementSpec}'s contract.
 */
export function spliceElementSpec(
  indent: string,
  unit: string,
  spec: ElementSpec,
  raw: string
): string {
  const root = parseFragment(raw);
  if (!root?.syntax.openBody) {
    return serializeElementSpec(indent, unit, spec);
  }

  const attributes = [
    attributeEdit(raw, root, "ident", spec.ident, true),
    attributeEdit(raw, root, "mode", spec.mode),
  ].filter((e): e is Edit => e !== undefined);

  if (root.syntax.isSelfClosing) {
    const tag = applyEdits(raw, attributes);
    const models = serializeModels(indent + unit, unit, spec.models);
    if (!models) {
      return indent + tag;
    }
    // Rules need a body, so reopen the tag.
    const open = tag.replace(/\s*\/>$/, ">");
    return `${indent}${open}\n${models}${indent}</${openName(raw, root)}>`;
  }

  const edits = [...attributes, ...modelEdits(raw, root, indent, unit, spec)];
  return indent + applyEdits(raw, edits);
}

/** Children the ODD content model puts after the rules, so rules go in front. */
const AFTER_MODELS = new Set(["exemplum", "remarks", "listRef"]);

interface Edit {
  start: number;
  /** Exclusive. Equal to `start` for a pure insertion. */
  end: number;
  text: string;
}

function applyEdits(raw: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) {
      continue;
    }
    out += raw.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + raw.slice(cursor);
}

/**
 * Set, replace, or (when the value is empty) drop an attribute of the start
 * tag. A `required` attribute is written even when empty, so clearing the ident
 * field leaves `ident=""` behind rather than a spec with no ident at all.
 */
function attributeEdit(
  raw: string,
  root: XMLElement,
  name: string,
  value?: string,
  required = false
): Edit | undefined {
  const existing = root.attributes.find((a) => a.key === name);
  if (existing) {
    const { startOffset, endOffset } = existing.position;
    if (value || required) {
      return {
        start: startOffset,
        end: endOffset + 1,
        text: `${name}="${escapeXmlAttr(value ?? "")}"`,
      };
    }
    // Take the separating whitespace with it, so the tag doesn't gape.
    let start = startOffset;
    while (start > 0 && (raw[start - 1] === " " || raw[start - 1] === "\t")) {
      start--;
    }
    return { start, end: endOffset + 1, text: "" };
  }
  if (!value && !required) {
    return undefined;
  }
  const last = root.attributes[root.attributes.length - 1];
  const anchor = last
    ? last.position.endOffset + 1
    : root.syntax.openName
      ? root.syntax.openName.endOffset + 1
      : undefined;
  return anchor === undefined
    ? undefined
    : {
        start: anchor,
        end: anchor,
        text: ` ${name}="${escapeXmlAttr(value ?? "")}"`,
      };
}

/** One existing rule, with whatever sits between it and the rule before it. */
interface Chunk {
  /** Comments and blank lines preceding the rule. Empty for the first one. */
  gap: string;
  /** The rule's own lines, verbatim. */
  body: string;
  /** How the rule serializes as parsed, for matching it against a new one. */
  key: string;
}

/** Edits that bring the element's run of rules in line with `spec.models`. */
function modelEdits(
  raw: string,
  root: XMLElement,
  indent: string,
  unit: string,
  spec: ElementSpec
): Edit[] {
  const bodyStart = root.syntax.openBody!.endOffset + 1;
  const bodyEnd = root.syntax.closeBody?.startOffset ?? raw.length;
  const inner = indent + unit;

  // A rule that serializes to nothing (no behaviour yet) is not written out,
  // so it takes no part in the matching either.
  const rules = spec.models
    .map((m) => serializeModel(inner, unit, m))
    .filter((text) => text.length > 0);

  const spans = root.subElements
    .filter((child) => MODEL_TYPES.has(localName(child.name)))
    .map((child) => lineSpan(raw, child.position, bodyStart, bodyEnd));

  if (spans.length === 0) {
    return rules.length > 0
      ? [insertRules(raw, root, indent, bodyStart, bodyEnd, rules.join(""))]
      : [];
  }

  const start = spans[0].start;
  const end = spans[spans.length - 1].end;
  if (hasInterleavedChild(root, start, end)) {
    // Rules with something else in between — invalid ODD, but rewriting the
    // span as a whole would move that something. Cut rule by rule instead.
    return spans.map((span, i) => ({
      ...span,
      text: i === 0 ? rules.join("") : "",
    }));
  }

  const chunks: Chunk[] = parseModels(raw, root).map((model, i) => ({
    gap: i === 0 ? "" : raw.slice(spans[i - 1].end, spans[i].start),
    body: raw.slice(spans[i].start, spans[i].end),
    key: serializeModel(inner, unit, model),
  }));

  return [{ start, end, text: rewriteRules(chunks, rules) }];
}

/**
 * Lay out the new rules over the old ones. A rule that still serializes exactly
 * as the source did is emitted from the source verbatim, so reordering or
 * editing a neighbour never reformats it or strips markup the form can't show.
 * Each old rule's preceding comment travels with it.
 */
function rewriteRules(chunks: Chunk[], rules: string[]): string {
  const taken = chunks.map(() => false);
  const match = rules.map(() => undefined as number | undefined);

  // Identical content first: that pairs a rule with its own source even when
  // the user has moved it up or down the list.
  rules.forEach((text, j) => {
    const i = chunks.findIndex((c, k) => !taken[k] && c.key === text);
    if (i >= 0) {
      taken[i] = true;
      match[j] = i;
    }
  });
  // Then by position, so an edited rule inherits the comment of the rule that
  // used to occupy its slot.
  let next = 0;
  rules.forEach((_, j) => {
    if (match[j] !== undefined) {
      return;
    }
    while (next < chunks.length && taken[next]) {
      next++;
    }
    if (next < chunks.length) {
      taken[next] = true;
      match[j] = next;
    }
  });

  const emitted = chunks.map(() => false);
  const gapOf = (i: number): string => {
    if (emitted[i]) {
      return "";
    }
    emitted[i] = true;
    return chunks[i].gap;
  };

  let out = "";
  rules.forEach((text, j) => {
    const i = match[j];
    if (i === undefined) {
      out += text;
      return;
    }
    out += gapOf(i) + (chunks[i].key === text ? chunks[i].body : text);
  });
  // Comments left over from deleted rules: keep them rather than drop them.
  chunks.forEach((_, i) => {
    out += gapOf(i);
  });
  return out;
}

/** True when a non-rule element sits inside the given range. */
function hasInterleavedChild(
  root: XMLElement,
  start: number,
  end: number
): boolean {
  return root.subElements.some(
    (child) =>
      !MODEL_TYPES.has(localName(child.name)) &&
      child.position.startOffset < end &&
      child.position.endOffset >= start
  );
}

/** Place a first rule into an element that has none. */
function insertRules(
  raw: string,
  root: XMLElement,
  indent: string,
  bodyStart: number,
  bodyEnd: number,
  rules: string
): Edit {
  const at = modelInsertOffset(raw, root, bodyStart, bodyEnd);
  if (at > 0 && raw[at - 1] !== "\n") {
    // Mid-line insertion point: open a line for the rules, and re-indent the
    // remainder of that line (typically the closing tag) behind them.
    const tail = at < raw.length ? indent : "";
    return { start: at, end: at, text: `\n${rules}${tail}` };
  }
  return { start: at, end: at, text: rules };
}

/** Where a first rule goes: after the last preceding child, before `remarks` & co. */
function modelInsertOffset(
  raw: string,
  root: XMLElement,
  bodyStart: number,
  bodyEnd: number
): number {
  let afterPreceding: number | undefined;
  let beforeFollowing: number | undefined;
  for (const child of root.subElements) {
    const name = localName(child.name);
    if (MODEL_TYPES.has(name)) {
      continue;
    }
    const span = lineSpan(raw, child.position, bodyStart, bodyEnd);
    if (AFTER_MODELS.has(name)) {
      beforeFollowing ??= span.start;
    } else {
      afterPreceding = span.end;
    }
  }
  if (
    afterPreceding !== undefined &&
    (beforeFollowing === undefined || afterPreceding <= beforeFollowing)
  ) {
    return afterPreceding;
  }
  if (beforeFollowing !== undefined) {
    return beforeFollowing;
  }
  // Empty body: on the line above the closing tag.
  return lineSpan(raw, { startOffset: bodyEnd, endOffset: bodyEnd - 1 }, bodyStart, bodyEnd)
    .start;
}

/**
 * Widen an element's range to the whole lines it occupies, so removing it
 * leaves no orphaned indentation or blank line. Whitespace-only neighbours on
 * those lines are absorbed; anything else leaves the range as it was. The
 * result never escapes `[bodyStart, bodyEnd)`, which keeps the enclosing tags
 * safe when an element shares their line.
 */
function lineSpan(
  raw: string,
  position: { startOffset: number; endOffset: number },
  bodyStart: number,
  bodyEnd: number
): { start: number; end: number } {
  const from = position.startOffset;
  const to = position.endOffset + 1;

  let start = from;
  const lineStart = raw.lastIndexOf("\n", from - 1) + 1;
  if (lineStart >= bodyStart && isBlank(raw.slice(lineStart, from))) {
    start = lineStart;
  }

  let end = to;
  const newline = raw.indexOf("\n", to);
  if (newline >= 0 && newline < bodyEnd && isBlank(raw.slice(to, newline))) {
    end = newline + 1;
  }

  return {
    start: Math.min(Math.max(start, bodyStart), bodyEnd),
    end: Math.min(Math.max(end, bodyStart), bodyEnd),
  };
}

function isBlank(text: string): boolean {
  return /^[ \t]*$/.test(text);
}

/** The element's name as written, prefix and all. */
function openName(raw: string, root: XMLElement): string {
  const token = root.syntax.openName;
  return token ? raw.slice(token.startOffset, token.endOffset + 1) : "elementSpec";
}

/** Parse a standalone `<elementSpec>` slice; undefined when it doesn't parse cleanly. */
function parseFragment(raw: string): XMLElement | undefined {
  const { cst, tokenVector, lexErrors, parseErrors } = parse(raw);
  if (lexErrors.length > 0 || parseErrors.length > 0) {
    return undefined;
  }
  return buildAst(cst as any, tokenVector).rootElement ?? undefined;
}
