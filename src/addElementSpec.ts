import * as vscode from "vscode";
import { parseOdd } from "./oddModel";
import { resolveParentOdd, extractElementSpecs, forceModeChange } from "./parentOdd";
import { BEHAVIOURS } from "./oddTypes";

/**
 * `oddTools.addElementSpec` — add an `<elementSpec>` to the document's
 * `<schemaSpec>`.
 *
 * The user either picks an ident inherited from the parent ODD (named by
 * `schemaSpec/@source`) or types a fresh one:
 *
 *   - **Inherited ident** → the parent's full `<elementSpec>` definition is
 *     copied in verbatim with `mode="change"`, re-indented to the document.
 *     This is the one thing the schema-aware completion (Red Hat XML) cannot do,
 *     since the schema only knows `ident` is an `xs:Name`, not which idents the
 *     inherited ODD defines.
 *
 *   - **New ident** → a blank `mode`/`<model>` scaffold is inserted as a snippet,
 *     with the `behaviour` value left for schema-driven completion to fill.
 *
 * Structural element/attribute completion is left entirely to the Red Hat XML
 * extension via the bound schema.
 */
export function registerAddElementSpec(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand("oddTools.addElementSpec", () =>
    addElementSpec(context)
  );
}

async function addElementSpec(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith(".odd")) {
    vscode.window.showWarningMessage("Open a .odd file to add an elementSpec.");
    return;
  }

  const document = editor.document;
  const text = document.getText();
  const model = parseOdd(text);
  if (model.empty || model.schemaSpecBodyEnd === undefined) {
    vscode.window.showWarningMessage(
      "No <schemaSpec> found in this ODD to add an elementSpec to."
    );
    return;
  }

  const defined = new Set(
    model.elementSpecs.map((s) => s.ident).filter((id): id is string => !!id)
  );
  const parent = model.meta.source
    ? await resolveParentOdd(document, model.meta.source, context)
    : undefined;

  const choice = await pickIdent(parent, defined);
  if (!choice) {
    return;
  }

  const position = insertionPosition(editor, model, text);

  if (choice.inherited && parent) {
    const raw = extractElementSpecs(parent.text).get(choice.ident)?.raw;
    if (!raw) {
      vscode.window.showWarningMessage(
        `Could not read <elementSpec ident="${choice.ident}"> from ${parent.label}.`
      );
      return;
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
  } else {
    await editor.insertSnippet(
      newSpecSnippet(model.elementSpecIndent, model.indentUnit, choice.ident),
      position
    );
  }
}

interface IdentChoice {
  ident: string;
  /** true → copy the parent's definition; false → insert a blank scaffold. */
  inherited: boolean;
}

/**
 * Offer the inherited idents not yet defined here, plus a free-text "new ident"
 * entry that appears as the user types. With no resolvable parent there is
 * nothing to inherit, so fall back to a plain input box.
 */
async function pickIdent(
  parent: { text: string; label: string } | undefined,
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
      // Keep inherited matches on top (so typing a prefix still narrows to them);
      // offer "create new" as a trailing, opt-in entry.
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

function validateIdent(value: string, defined: Set<string>): string | undefined {
  const v = value.trim();
  if (!v) {
    return undefined; // empty: no error yet, just can't submit
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
 * Where to drop the new elementSpec: the start of the cursor's line when it sits
 * inside the schemaSpec body, otherwise the start of the `</schemaSpec>` line.
 * Always column 0, so snippet insertion adds no surprise base indentation.
 */
function insertionPosition(
  editor: vscode.TextEditor,
  model: ReturnType<typeof parseOdd>,
  text: string
): vscode.Position {
  const bodyEnd = model.schemaSpecBodyEnd!;
  const bodyStart = model.metaRange ? model.metaRange.end : 0;
  const cursor = editor.document.offsetAt(editor.selection.active);
  const target = cursor > bodyStart && cursor <= bodyEnd ? cursor : bodyEnd;
  return editor.document.positionAt(lineStartOffset(text, target));
}

/** Select the inserted block and scroll it into view. */
function revealInserted(
  editor: vscode.TextEditor,
  start: vscode.Position,
  block: string
): void {
  const end = editor.document.positionAt(
    editor.document.offsetAt(start) + block.length
  );
  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(new vscode.Range(start, end));
}

/**
 * Re-indent a verbatim `<elementSpec>` slice from the parent ODD. The slice's
 * first line carries no indent (it starts at `<elementSpec`); following lines
 * begin at `parentIndent`. Swap that base prefix for `targetIndent`, leaving the
 * deeper relative indentation untouched, so `xml:space="preserve"` template and
 * outputRendition content keeps its internal whitespace.
 */
function reindentRaw(raw: string, parentIndent: string, targetIndent: string): string {
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
function newSpecSnippet(
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

/** Offset of the start of the line containing `offset`. */
function lineStartOffset(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/** Leading whitespace of the line containing `offset`. */
function lineIndentForOffset(text: string, offset: number): string {
  const start = lineStartOffset(text, offset);
  return (/^[ \t]*/.exec(text.slice(start, offset)) ?? [""])[0];
}
