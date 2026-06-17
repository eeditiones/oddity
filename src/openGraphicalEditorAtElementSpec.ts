import * as vscode from "vscode";
import { findElementSpecAtOffset } from "./elementSpecInsert";
import {
  getOddEditorPanel,
  setPendingElementSpecSelection,
} from "./oddEditorPanels";
import { OddEditorProvider } from "./oddEditorProvider";
import { parseOdd } from "./oddModel";

const CURSOR_IN_ELEMENT_SPEC_CONTEXT = "oddTools.cursorInElementSpec";

export function registerOpenGraphicalEditorAtElementSpec(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const updateContext = () => {
    void vscode.commands.executeCommand(
      "setContext",
      CURSOR_IN_ELEMENT_SPEC_CONTEXT,
      cursorInElementSpec(vscode.window.activeTextEditor)
    );
  };

  updateContext();

  return vscode.Disposable.from(
    vscode.commands.registerCommand(
      "oddTools.openGraphicalEditorAtElementSpec",
      () => openGraphicalEditorAtElementSpec()
    ),
    vscode.window.onDidChangeActiveTextEditor(() => updateContext()),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document.fileName.endsWith(".odd")) {
        updateContext();
      }
    })
  );
}

function cursorInElementSpec(editor?: vscode.TextEditor): boolean {
  if (!editor?.document.fileName.endsWith(".odd")) {
    return false;
  }
  const offset = editor.document.offsetAt(editor.selection.active);
  return findElementSpecAtOffset(parseOdd(editor.document.getText()), offset) !==
    undefined;
}

/** Open the graphical editor beside the source and select the spec at the cursor. */
export async function openGraphicalEditorAtElementSpec(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor?.document.fileName.endsWith(".odd")) {
    vscode.window.showWarningMessage(
      "Open a .odd file in the text editor first."
    );
    return;
  }

  const document = editor.document;
  const cursorOffset = document.offsetAt(editor.selection.active);
  const hit = findElementSpecAtOffset(parseOdd(document.getText()), cursorOffset);
  if (!hit) {
    vscode.window.showInformationMessage(
      "Place the cursor inside an <elementSpec> to open it in the graphical editor."
    );
    return;
  }

  const selection = { ident: hit.spec.ident, index: hit.index };
  const existing = getOddEditorPanel(document.uri);
  if (existing) {
    existing.panel.reveal();
    existing.panel.webview.postMessage({
      type: "selectIdent",
      ident: hit.spec.ident,
      index: hit.index,
    });
    return;
  }

  setPendingElementSpecSelection(document.uri, selection);
  await vscode.commands.executeCommand(
    "vscode.openWith",
    document.uri,
    OddEditorProvider.viewType,
    vscode.ViewColumn.Beside
  );
}
