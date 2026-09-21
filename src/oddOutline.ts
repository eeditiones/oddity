import * as vscode from "vscode";
import { parse } from "@xml-tools/parser";
import { buildAst, XMLElement } from "@xml-tools/ast";
import { localName, attr, findElements } from "./xmlUtils";

/**
 * Document outline for TEI ODD files.
 *
 * Instead of the generic XML tree, the outline surfaces the ODD-specific
 * structure: `<tagsDecl>` (behaviours, renditions, namespaces) and each
 * `<schemaSpec>` with its module references, data/macro/class/element specs.
 * `<elementSpec>` entries list nested `<model>` / `<modelGrp>` /
 * `<modelSequence>` rules as a tree.
 */
export class OddDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument
  ): vscode.DocumentSymbol[] {
    const { cst, tokenVector } = parse(document.getText());
    const ast = buildAst(cst as any, tokenVector);
    const symbols: vscode.DocumentSymbol[] = [];
    for (const tagsDecl of findElements(ast, "tagsDecl")) {
      symbols.push(this.buildTagsDeclSymbol(document, tagsDecl));
    }
    for (const schemaSpec of findElements(ast, "schemaSpec")) {
      symbols.push(this.buildSchemaSpecSymbol(document, schemaSpec));
    }
    return symbols;
  }

  private buildTagsDeclSymbol(
    document: vscode.TextDocument,
    tagsDecl: XMLElement
  ): vscode.DocumentSymbol {
    const range = elementRange(document, tagsDecl);
    const symbol = new vscode.DocumentSymbol(
      "tagsDecl",
      "",
      vscode.SymbolKind.Namespace,
      range,
      nameRange(document, tagsDecl, range)
    );
    symbol.children = tagsDecl.subElements
      .map((child) => this.buildTagsDeclChildSymbol(document, child))
      .filter((s): s is vscode.DocumentSymbol => s !== undefined);
    return symbol;
  }

  private buildTagsDeclChildSymbol(
    document: vscode.TextDocument,
    element: XMLElement
  ): vscode.DocumentSymbol | undefined {
    const local = localName(element.name);
    const range = elementRange(document, element);
    const name = nameRange(document, element, range);

    if (local === "behaviour") {
      const ident = attr(element, "ident") ?? "(no ident)";
      const output = attr(element, "output");
      const label = output ? `${ident} · ${output}` : ident;
      return new vscode.DocumentSymbol(
        label,
        "",
        vscode.SymbolKind.Method,
        range,
        name
      );
    }
    if (local === "rendition") {
      const label =
        attr(element, "xml:id") ?? attr(element, "source") ?? "(rendition)";
      return new vscode.DocumentSymbol(
        label,
        "",
        vscode.SymbolKind.Property,
        range,
        name
      );
    }
    if (local === "namespace") {
      const label = attr(element, "name") ?? "(namespace)";
      return new vscode.DocumentSymbol(
        label,
        "",
        vscode.SymbolKind.Namespace,
        range,
        name
      );
    }
    return undefined;
  }

  private buildSchemaSpecSymbol(
    document: vscode.TextDocument,
    schemaSpec: XMLElement
  ): vscode.DocumentSymbol {
    const ident = attr(schemaSpec, "ident") ?? "(no ident)";
    const source = attr(schemaSpec, "source");
    const range = elementRange(document, schemaSpec);
    const symbol = new vscode.DocumentSymbol(
      ident,
      source ? `source: ${source}` : "",
      vscode.SymbolKind.Package,
      range,
      nameRange(document, schemaSpec, range)
    );
    symbol.children = schemaSpec.subElements
      .map((child) => this.buildSchemaSpecChildSymbol(document, child))
      .filter((s): s is vscode.DocumentSymbol => s !== undefined);
    return symbol;
  }

  private buildSchemaSpecChildSymbol(
    document: vscode.TextDocument,
    element: XMLElement
  ): vscode.DocumentSymbol | undefined {
    const local = localName(element.name);
    switch (local) {
      case "moduleRef":
        return this.buildModuleRefSymbol(document, element);
      case "dataSpec":
        return this.buildIdentSpecSymbol(
          document,
          element,
          vscode.SymbolKind.TypeParameter
        );
      case "macroSpec":
        return this.buildIdentSpecSymbol(
          document,
          element,
          vscode.SymbolKind.Constant
        );
      case "classSpec":
        return this.buildClassSpecSymbol(document, element);
      case "elementSpec":
        return this.buildElementSpecSymbol(document, element);
      default:
        return undefined;
    }
  }

  private buildModuleRefSymbol(
    document: vscode.TextDocument,
    moduleRef: XMLElement
  ): vscode.DocumentSymbol {
    const key = attr(moduleRef, "key") ?? "(no key)";
    const detail = moduleRefDetail(moduleRef);
    const range = elementRange(document, moduleRef);
    return new vscode.DocumentSymbol(
      key,
      detail,
      vscode.SymbolKind.Module,
      range,
      nameRange(document, moduleRef, range)
    );
  }

  private buildIdentSpecSymbol(
    document: vscode.TextDocument,
    spec: XMLElement,
    kind: vscode.SymbolKind
  ): vscode.DocumentSymbol {
    const ident = attr(spec, "ident") ?? "(no ident)";
    const mode = attr(spec, "mode");
    const range = elementRange(document, spec);
    return new vscode.DocumentSymbol(
      ident,
      mode ?? "",
      kind,
      range,
      nameRange(document, spec, range)
    );
  }

  private buildClassSpecSymbol(
    document: vscode.TextDocument,
    classSpec: XMLElement
  ): vscode.DocumentSymbol {
    const ident = attr(classSpec, "ident") ?? "(no ident)";
    const type = attr(classSpec, "type");
    const mode = attr(classSpec, "mode");
    const detail = [type, mode].filter(Boolean).join(" · ");
    const range = elementRange(document, classSpec);
    return new vscode.DocumentSymbol(
      ident,
      detail,
      vscode.SymbolKind.Interface,
      range,
      nameRange(document, classSpec, range)
    );
  }

  private buildElementSpecSymbol(
    document: vscode.TextDocument,
    elementSpec: XMLElement
  ): vscode.DocumentSymbol {
    const ident = attr(elementSpec, "ident") ?? "(no ident)";
    const mode = attr(elementSpec, "mode");
    const range = elementRange(document, elementSpec);
    const symbol = new vscode.DocumentSymbol(
      ident,
      mode ?? "",
      vscode.SymbolKind.Class,
      range,
      nameRange(document, elementSpec, range)
    );
    symbol.children = this.collectRules(document, elementSpec);
    return symbol;
  }

  /** Direct `<model>` / `<modelGrp>` / `<modelSequence>` children, nested as in the ODD. */
  private collectRules(
    document: vscode.TextDocument,
    parent: XMLElement
  ): vscode.DocumentSymbol[] {
    const out: vscode.DocumentSymbol[] = [];
    for (const child of parent.subElements) {
      const local = localName(child.name);
      if (local === "model" || local === "modelGrp" || local === "modelSequence") {
        out.push(this.buildRuleSymbol(document, child, local));
      }
    }
    return out;
  }

  private buildRuleSymbol(
    document: vscode.TextDocument,
    rule: XMLElement,
    type: "model" | "modelGrp" | "modelSequence"
  ): vscode.DocumentSymbol {
    const range = elementRange(document, rule);
    const symbol = new vscode.DocumentSymbol(
      ruleLabel(rule, type),
      "",
      ruleKind(type),
      range,
      nameRange(document, rule, range)
    );
    if (type !== "model") {
      symbol.children = this.collectRules(document, rule);
    }
    return symbol;
  }
}

function ruleKind(type: "model" | "modelGrp" | "modelSequence"): vscode.SymbolKind {
  if (type === "modelGrp") {
    return vscode.SymbolKind.Namespace;
  }
  if (type === "modelSequence") {
    return vscode.SymbolKind.Array;
  }
  return vscode.SymbolKind.Method;
}

/** `output · predicate · behaviour|modelGrp|modelSequence`, omitting empty parts. */
function ruleLabel(
  rule: XMLElement,
  type: "model" | "modelGrp" | "modelSequence"
): string {
  const parts: string[] = [];
  const output = attr(rule, "output");
  const predicate = attr(rule, "predicate");
  if (output) {
    parts.push(output);
  }
  if (predicate) {
    parts.push(predicate);
  }
  parts.push(type === "model" ? (attr(rule, "behaviour") ?? "(no behaviour)") : type);
  return parts.join(" · ");
}

/** Summary of a `<moduleRef>`'s include/except attributes. */
function moduleRefDetail(moduleRef: XMLElement): string {
  const include = attr(moduleRef, "include");
  const except = attr(moduleRef, "except");
  if (include && except) {
    return `include: ${include} · except: ${except}`;
  }
  if (include) {
    return `include: ${include}`;
  }
  if (except) {
    return `except: ${except}`;
  }
  return "";
}

/** Convert an element's source span into a VS Code range. */
function elementRange(
  document: vscode.TextDocument,
  element: XMLElement
): vscode.Range {
  const p = element.position;
  if (!p || p.startOffset < 0) {
    return new vscode.Range(0, 0, 0, 0);
  }
  return new vscode.Range(
    document.positionAt(p.startOffset),
    document.positionAt(p.endOffset + 1)
  );
}

/** Range covering just the element's name token, for the selection range. */
function nameRange(
  document: vscode.TextDocument,
  element: XMLElement,
  fallback: vscode.Range
): vscode.Range {
  const open = element.syntax?.openName;
  if (open && open.startOffset >= 0) {
    return new vscode.Range(
      document.positionAt(open.startOffset),
      document.positionAt(open.endOffset + 1)
    );
  }
  return fallback;
}
