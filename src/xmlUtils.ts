import { XMLElement, XMLAttribute, XMLDocument } from "@xml-tools/ast";

/** Local name of an element/attribute, stripping any namespace prefix. */
export function localName(name: string | null): string {
  if (!name) {
    return "";
  }
  const idx = name.indexOf(":");
  return idx === -1 ? name : name.slice(idx + 1);
}

/** Escape a string for use inside a double-quoted XML attribute value. */
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

/** Decode XML entities in an attribute value (@xml-tools leaves them literal). */
export function unescapeXmlAttr(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(quot|lt|gt|apos|amp));/g,
    (_, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec !== undefined) {
        return String.fromCharCode(Number(dec));
      }
      if (hex !== undefined) {
        return String.fromCharCode(parseInt(hex, 16));
      }
      const entities: Record<string, string> = {
        quot: '"',
        lt: "<",
        gt: ">",
        apos: "'",
        amp: "&",
      };
      return name ? entities[name] : "&";
    }
  );
}

/** Value of an attribute by (full) key, or undefined when absent/empty. */
export function attr(element: XMLElement, key: string): string | undefined {
  const found = element.attributes.find(
    (a: XMLAttribute) => a.key === key && a.value !== null
  );
  const raw = found?.value;
  return raw !== undefined && raw !== null ? unescapeXmlAttr(raw) : undefined;
}

/** Depth-first visit of every element under the given root (inclusive). */
export function visit(
  root: XMLDocument | XMLElement,
  fn: (el: XMLElement) => void
): void {
  const walk = (el: XMLElement) => {
    fn(el);
    for (const child of el.subElements) {
      walk(child);
    }
  };
  const start =
    "rootElement" in root
      ? root.rootElement
        ? [root.rootElement]
        : []
      : [root];
  start.forEach(walk);
}

/** All descendant elements with the given local name, in document order. */
export function findElements(
  root: XMLDocument | XMLElement,
  name: string
): XMLElement[] {
  const result: XMLElement[] = [];
  visit(root, (el) => {
    if (localName(el.name) === name) {
      result.push(el);
    }
  });
  return result;
}
