import * as vscode from "vscode";
import { insertElementSpecSnippet } from "./elementSpecInsert";

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

  await insertElementSpecSnippet(editor, context);
}
