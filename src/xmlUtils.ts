import { XMLElement, XMLAttribute, XMLDocument } from "@xml-tools/ast";

/** Local name of an element/attribute, stripping any namespace prefix. */
export function localName(name: string | null): string {
  if (!name) {
    return "";
  }
  const idx = name.indexOf(":");
  return idx === -1 ? name : name.slice(idx + 1);
}

/** Value of an attribute by (full) key, or undefined when absent/empty. */
export function attr(element: XMLElement, key: string): string | undefined {
  const found = element.attributes.find(
    (a: XMLAttribute) => a.key === key && a.value !== null
  );
  return found?.value ?? undefined;
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
