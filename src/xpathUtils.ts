import { ElementSpec, ModelNode } from "./oddTypes";

/**
 * Prefer single-quoted XPath string literals so attribute values stay readable
 * in ODD XML (no `&quot;` entities). Double-quoted literals are rewritten to
 * single-quoted ones; embedded single quotes use XPath's `''` escape.
 *
 * The expression is scanned with awareness of XPath string context so that a
 * double quote appearing *inside* a single-quoted literal (e.g. building JSON
 * with `'"key":"' || …`) is treated as content, not as a delimiter, and left
 * untouched. `''` / `""` doubled-quote escapes are honoured on both sides.
 */
export function preferSingleQuotedStrings(expr: string): string {
  let result = "";
  let i = 0;
  const n = expr.length;
  while (i < n) {
    const ch = expr[i];
    if (ch === "'") {
      // Single-quoted literal: copy verbatim, honouring '' escapes.
      result += ch;
      i++;
      while (i < n) {
        if (expr[i] === "'") {
          if (expr[i + 1] === "'") {
            result += "''";
            i += 2;
            continue;
          }
          result += "'";
          i++;
          break;
        }
        result += expr[i];
        i++;
      }
    } else if (ch === '"') {
      // Double-quoted literal: rewrite as single-quoted, honouring "" escapes.
      i++;
      let inner = "";
      while (i < n) {
        if (expr[i] === '"') {
          if (expr[i + 1] === '"') {
            inner += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        inner += expr[i];
        i++;
      }
      result += `'${inner.replace(/'/g, "''")}'`;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
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
