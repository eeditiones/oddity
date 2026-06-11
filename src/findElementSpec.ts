import * as vscode from "vscode";
import { getActiveOddEditor } from "./oddEditorPanels";
import { parseOdd } from "./oddModel";

export function registerFindElementSpec(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand("oddTools.findElementSpec", () =>
    showElementSpecPicker()
  );
}

/** Open the elementSpec picker for the active graphical editor, if any. */
export async function showElementSpecPicker(): Promise<void> {
  const entry = getActiveOddEditor();
  if (!entry) {
    return;
  }

  const model = parseOdd(entry.document.getText());
  if (model.empty || model.elementSpecs.length === 0) {
    vscode.window.showInformationMessage("No elementSpecs in this ODD.");
    return;
  }

  const items = model.elementSpecs.map((spec, index) => ({
    label: spec.ident || `(element ${index + 1})`,
    description: spec.mode,
    index,
    ident: spec.ident,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    title: "Go to elementSpec",
    placeHolder: "Filter by ident…",
    matchOnDescription: true,
  });
  if (!pick) {
    return;
  }

  entry.panel.webview.postMessage({
    type: "selectIdent",
    ident: pick.ident || undefined,
    index: pick.index,
  });
}
