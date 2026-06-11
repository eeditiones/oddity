import { ElementSpec, ModelNode } from "./oddTypes";

/**
 * Prefer single-quoted XPath string literals so attribute values stay readable
 * in ODD XML (no `&quot;` entities). Double-quoted literals are rewritten when
 * possible; embedded single quotes use XPath's `''` escape.
 */
export function preferSingleQuotedStrings(expr: string): string {
  return expr.replace(/"([^"]*)"/g, (_, inner: string) => {
    const escaped = inner.replace(/'/g, "''");
    return `'${escaped}'`;
  });
}

/** Normalize predicates and parameter values in place to match serialization. */
export function normalizeXPathFields(spec: ElementSpec): void {
  const walk = (model: ModelNode) => {
    if (model.predicate) {
      model.predicate = preferSingleQuotedStrings(model.predicate);
    }
    for (const param of model.params) {
      if (param.value) {
        param.value = preferSingleQuotedStrings(param.value);
      }
    }
    for (const child of model.models) {
      walk(child);
    }
  };
  for (const model of spec.models) {
    walk(model);
  }
}
