import * as vscode from "vscode";
import { parseOdd } from "./oddModel";
import { serializeElementSpec } from "./oddSerialize";
import { BEHAVIOURS, ElementSpec } from "./oddTypes";
import {
  resolveParentOdd,
  extractElementSpecs,
  forceModeChange,
  ResolvedParent,
} from "./parentOdd";

export interface IdentChoice {
  ident: string;
  /** true → copy the parent's definition; false → insert a blank scaffold. */
  inherited: boolean;
}

export interface InsertElementSpecResult {
  ident: string;
  /** Byte offset where the new spec was inserted (start of its line). */
  offset: number;
}

/**
 * Pick an ident (when needed) and insert an `<elementSpec>` into the document's
 * `<schemaSpec>`. Shared by the text-editor command and the graphical editor.
 */
export async function insertElementSpec(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  options: { ident?: string; cursorOffset?: number } = {}
): Promise<InsertElementSpecResult | undefined> {
  const text = document.getText();
  const model = parseOdd(text);
  if (model.empty || model.schemaSpecBodyEnd === undefined) {
    vscode.window.showWarningMessage(
      "No <schemaSpec> found in this ODD to add an elementSpec to."
    );
    return undefined;
  }

  const defined = new Set(
    model.elementSpecs.map((s) => s.ident).filter((id): id is string => !!id)
  );
  const parent = model.meta.source
    ? await resolveParentOdd(document, model.meta.source, context)
    : undefined;

  const choice = options.ident
    ? resolveIdentChoice(options.ident, defined, parent)
    : await pickIdent(parent, defined);

  if (!choice) {
    return undefined;
  }
  if ("error" in choice) {
    vscode.window.showWarningMessage(choice.error);
    return undefined;
  }

  const offset = schemaSpecInsertionOffset(
    text,
    model,
    options.cursorOffset
  );
  const position = document.positionAt(offset);

  if (choice.inherited && parent) {
    const raw = extractElementSpecs(parent.text).get(choice.ident)?.raw;
    if (!raw) {
      vscode.window.showWarningMessage(
        `Could not read <elementSpec ident="${choice.ident}"> from ${parent.label}.`
      );
      return undefined;
    }
    const parentIndent = lineIndentForOffset(parent.text, parent.text.indexOf(raw));
    const block = reindentRaw(
      forceModeChange(raw),
      parentIndent,
      model.elementSpecIndent
    );
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, position, `${block}\n`);
    await vscode.workspace.applyEdit(edit);
    return { ident: choice.ident, offset };
  }

  const spec = { ident: choice.ident, mode: "change", models: [] };
  const xml = serializeElementSpec(model.elementSpecIndent, model.indentUnit, spec);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, position, `${xml}\n`);
  await vscode.workspace.applyEdit(edit);
  return { ident: choice.ident, offset };
}

/** Insert a copied elementSpec from the graphical-editor clipboard. */
export async function insertElementSpecFromClipboard(
  document: vscode.TextDocument,
  spec: ElementSpec
): Promise<InsertElementSpecResult | undefined> {
  const text = document.getText();
  const model = parseOdd(text);
  if (model.empty || model.schemaSpecBodyEnd === undefined) {
    vscode.window.showWarningMessage(
      "No <schemaSpec> found in this ODD to paste an elementSpec into."
    );
    return undefined;
  }

  const defined = new Set(
    model.elementSpecs.map((s) => s.ident).filter((id): id is string => !!id)
  );
  const ident = uniqueIdent(spec.ident?.trim() || "copy", defined);
  const copySpec: ElementSpec = { ...spec, ident };
  const offset = schemaSpecInsertionOffset(text, model);
  const position = document.positionAt(offset);
  const xml = serializeElementSpec(
    model.elementSpecIndent,
    model.indentUnit,
    copySpec
  );
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, position, `${xml}\n`);
  await vscode.workspace.applyEdit(edit);
  return { ident, offset };
}

function uniqueIdent(base: string, defined: Set<string>): string {
  if (!defined.has(base)) {
    return base;
  }
  let candidate = `${base}_copy`;
  let n = 2;
  while (defined.has(candidate)) {
    candidate = `${base}_copy${n}`;
    n += 1;
  }
  return candidate;
}

/** Insert a blank scaffold as a snippet (text editor command). */
export async function insertElementSpecSnippet(
  editor: vscode.TextEditor,
  context: vscode.ExtensionContext
): Promise<InsertElementSpecResult | undefined> {
  const document = editor.document;
  const text = document.getText();
  const model = parseOdd(text);
  if (model.empty || model.schemaSpecBodyEnd === undefined) {
    vscode.window.showWarningMessage(
      "No <schemaSpec> found in this ODD to add an elementSpec to."
    );
    return undefined;
  }

  const defined = new Set(
    model.elementSpecs.map((s) => s.ident).filter((id): id is string => !!id)
  );
  const parent = model.meta.source
    ? await resolveParentOdd(document, model.meta.source, context)
    : undefined;

  const choice = await pickIdent(parent, defined);
  if (!choice) {
    return undefined;
  }

  const cursor = document.offsetAt(editor.selection.active);
  const offset = schemaSpecInsertionOffset(text, model, cursor);
  const position = document.positionAt(offset);

  if (choice.inherited && parent) {
    const raw = extractElementSpecs(parent.text).get(choice.ident)?.raw;
    if (!raw) {
      vscode.window.showWarningMessage(
        `Could not read <elementSpec ident="${choice.ident}"> from ${parent.label}.`
      );
      return undefined;
    }
    const parentIndent = lineIndentForOffset(parent.text, parent.text.indexOf(raw));
    const block = reindentRaw(
      forceModeChange(raw),
      parentIndent,
      model.elementSpecIndent
    );
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, position, `${block}\n`);
    await vscode.workspace.applyEdit(edit);
    revealInserted(editor, position, block);
    return { ident: choice.ident, offset };
  }

  await editor.insertSnippet(
    newSpecSnippet(model.elementSpecIndent, model.indentUnit, choice.ident),
    position
  );
  revealAt(editor, position);
  return { ident: choice.ident, offset };
}

/** Resolve a typed ident: inherit from parent when available, otherwise scaffold. */
export function resolveIdentChoice(
  ident: string,
  defined: Set<string>,
  parent: ResolvedParent | undefined
): IdentChoice | { error: string } | undefined {
  const trimmed = ident.trim();
  if (!trimmed) {
    return undefined;
  }
  const validation = validateIdent(trimmed, defined);
  if (validation) {
    return { error: validation };
  }
  const inherited =
    !!parent && extractElementSpecs(parent.text).has(trimmed);
  return { ident: trimmed, inherited };
}

/**
 * Offer inherited idents not yet defined here, plus a free-text "new ident"
 * entry that appears as the user types.
 */
export async function pickIdent(
  parent: ResolvedParent | undefined,
  defined: Set<string>
): Promise<IdentChoice | undefined> {
  const inherited = parent
    ? [...extractElementSpecs(parent.text).keys()]
        .filter((id) => !defined.has(id))
        .sort()
    : [];

  if (inherited.length === 0) {
    const ident = await vscode.window.showInputBox({
      title: "Add elementSpec",
      prompt: "Ident of the element to specify",
      validateInput: (v) => validateIdent(v, defined),
    });
    const trimmed = ident?.trim();
    return trimmed ? { ident: trimmed, inherited: false } : undefined;
  }

  const known = new Set(inherited);
  const baseItems: vscode.QuickPickItem[] = inherited.map((id) => ({
    label: id,
    description: `inherit from ${parent!.label}`,
  }));

  return new Promise<IdentChoice | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = "Add elementSpec";
    qp.placeholder = `Inherit an element from ${parent!.label}, or type a new ident`;
    qp.matchOnDescription = true;
    qp.items = baseItems;

    qp.onDidChangeValue((value) => {
      const v = value.trim();
      qp.items =
        v && !known.has(v) && !defined.has(v)
          ? [
              ...baseItems,
              {
                label: v,
                description: "new element spec",
                alwaysShow: true,
                iconPath: new vscode.ThemeIcon("add"),
              },
            ]
          : baseItems;
    });

    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      qp.hide();
      resolve(sel ? { ident: sel.label, inherited: known.has(sel.label) } : undefined);
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

export function validateIdent(
  value: string,
  defined: Set<string>
): string | undefined {
  const v = value.trim();
  if (!v) {
    return undefined;
  }
  if (defined.has(v)) {
    return `An elementSpec with ident "${v}" already exists.`;
  }
  if (!/^[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?$/.test(v)) {
    return "Not a valid element name.";
  }
  return undefined;
}

/**
 * Where to insert a new `<elementSpec>`:
 *
 * - cursor inside an existing `<elementSpec>` → immediately after it;
 * - otherwise → on the line before `</schemaSpec>`.
 *
 * Never splits an existing spec mid-element, which would break validity.
 */
export function schemaSpecInsertionOffset(
  text: string,
  model: ReturnType<typeof parseOdd>,
  cursorOffset?: number
): number {
  const bodyEnd = model.schemaSpecBodyEnd!;
  const bodyStart = model.metaRange ? model.metaRange.end : 0;

  if (
    cursorOffset !== undefined &&
    cursorOffset > bodyStart &&
    cursorOffset < bodyEnd
  ) {
    const containing = model.elementSpecs.find(
      (spec) =>
        spec.range &&
        cursorOffset >= spec.range.start &&
        cursorOffset < spec.range.end
    );
    if (containing?.range) {
      return offsetAfterElement(text, containing.range.end);
    }
  }

  return lineStartOffset(text, bodyEnd);
}

/** Byte offset for inserting on the line after an element's closing tag. */
function offsetAfterElement(text: string, elementEnd: number): number {
  let offset = elementEnd;
  if (text[offset] === "\n") {
    offset += 1;
  }
  return offset;
}

/** Select the inserted block and scroll it into view. */
export function revealInserted(
  editor: vscode.TextEditor,
  start: vscode.Position,
  block: string
): void {
  const end = editor.document.positionAt(
    editor.document.offsetAt(start) + block.length
  );
  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
}

/** Move the caret to an insertion point and scroll it into view. */
export function revealAt(editor: vscode.TextEditor, position: vscode.Position): void {
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenter
  );
}

/**
 * Re-indent a verbatim `<elementSpec>` slice from the parent ODD.
 */
export function reindentRaw(
  raw: string,
  parentIndent: string,
  targetIndent: string
): string {
  return raw
    .split("\n")
    .map((line, i) => {
      if (i === 0) {
        return targetIndent + line;
      }
      if (parentIndent && line.startsWith(parentIndent)) {
        return targetIndent + line.slice(parentIndent.length);
      }
      return line;
    })
    .join("\n");
}

/** Blank elementSpec scaffold for a fresh ident; `behaviour` is left for schema completion. */
export function newSpecSnippet(
  indent: string,
  unit: string,
  ident: string
): vscode.SnippetString {
  const id = escapeSnippet(ident);
  const behaviours = BEHAVIOURS.join(",");
  return new vscode.SnippetString(
    [
      `${indent}<elementSpec ident="${id}" mode="\${1|change,add,delete,replace|}">`,
      `${indent}${unit}<model\${2: predicate="\${3:@type}"} behaviour="\${4|${behaviours}|}">`,
      `${indent}${unit}${unit}\$0`,
      `${indent}${unit}</model>`,
      `${indent}</elementSpec>`,
      "",
    ].join("\n")
  );
}

function escapeSnippet(text: string): string {
  return text.replace(/[\\$}]/g, "\\$&");
}

function lineStartOffset(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineIndentForOffset(text: string, offset: number): string {
  const start = lineStartOffset(text, offset);
  return (/^[ \t]*/.exec(text.slice(start, offset)) ?? [""])[0];
}
