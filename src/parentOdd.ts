import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { parse } from "@xml-tools/parser";
import { buildAst } from "@xml-tools/ast";
import { localName, attr, visit } from "./xmlUtils";

/**
 * Resolve and read the ODD that a `<schemaSpec source="…">` inherits from, and
 * extract the `<elementSpec>` definitions it contributes so they can be copied
 * into the child ODD.
 *
 * Resolution order (most-to-least authoritative):
 *   1. Sibling file next to the current ODD — the normal TEI Publisher layout,
 *      and the copy whose version matches the user's project.
 *   2. Any file with the same name elsewhere in the workspace.
 *   3. A copy bundled with the extension (`schemas/<name>`), as an offline
 *      fallback when nothing project-local can be found.
 */

export interface ResolvedParent {
  /** Human-readable origin, shown in completion detail. */
  label: string;
  text: string;
}

export interface ParentElementSpec {
  ident: string;
  /** Verbatim source slice of the `<elementSpec>` element. */
  raw: string;
}

export async function resolveParentOdd(
  document: vscode.TextDocument,
  source: string,
  context: vscode.ExtensionContext
): Promise<ResolvedParent | undefined> {
  const base = path.basename(source);

  // 1. Sibling of the current file.
  const sibling = path.resolve(path.dirname(document.uri.fsPath), source);
  if (fs.existsSync(sibling)) {
    try {
      return { label: base, text: fs.readFileSync(sibling, "utf8") };
    } catch {
      /* fall through */
    }
  }

  // 2. Same filename elsewhere in the workspace.
  const found = await vscode.workspace.findFiles(
    `**/${base}`,
    "**/node_modules/**",
    1
  );
  if (found.length) {
    try {
      const bytes = await vscode.workspace.fs.readFile(found[0]);
      return {
        label: vscode.workspace.asRelativePath(found[0]),
        text: Buffer.from(bytes).toString("utf8"),
      };
    } catch {
      /* fall through */
    }
  }

  // 3. Bundled fallback.
  const bundled = context.asAbsolutePath(path.join("schemas", base));
  if (fs.existsSync(bundled)) {
    try {
      return { label: `${base} (bundled)`, text: fs.readFileSync(bundled, "utf8") };
    } catch {
      /* fall through */
    }
  }

  return undefined;
}

// Single-entry memo: the parent ODD changes rarely, completion fires often.
let memoText: string | undefined;
let memoSpecs: Map<string, ParentElementSpec> | undefined;

/** Extract `<elementSpec ident="…">` definitions, keyed by ident. */
export function extractElementSpecs(
  text: string
): Map<string, ParentElementSpec> {
  if (text === memoText && memoSpecs) {
    return memoSpecs;
  }
  const { cst, tokenVector } = parse(text);
  const ast = buildAst(cst as any, tokenVector);
  const map = new Map<string, ParentElementSpec>();
  visit(ast, (el) => {
    if (localName(el.name) !== "elementSpec") {
      return;
    }
    const ident = attr(el, "ident");
    const p = el.position;
    if (ident && !map.has(ident) && p && p.startOffset >= 0) {
      map.set(ident, { ident, raw: text.slice(p.startOffset, p.endOffset + 1) });
    }
  });
  memoText = text;
  memoSpecs = map;
  return map;
}

// (xml helpers now live in ./xmlUtils)

/**
 * Rewrite the opening tag of an `<elementSpec>` source slice so its `mode` is
 * `change` — the usual intent when overriding an inherited definition. Only the
 * opening tag is touched, so any `xml:space="preserve"` template content inside
 * is preserved byte-for-byte.
 */
export function forceModeChange(raw: string): string {
  const gt = raw.indexOf(">");
  if (gt === -1) {
    return raw;
  }
  let open = raw.slice(0, gt);
  const rest = raw.slice(gt);

  if (/\bmode\s*=\s*"[^"]*"/.test(open)) {
    open = open.replace(/\bmode\s*=\s*"[^"]*"/, 'mode="change"');
  } else if (/\bident\s*=\s*"[^"]*"/.test(open)) {
    open = open.replace(/(\bident\s*=\s*"[^"]*")/, '$1 mode="change"');
  } else {
    open = open.replace(/^(<\s*[\w:]+)/, '$1 mode="change"');
  }
  return open + rest;
}
