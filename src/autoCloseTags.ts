import * as vscode from "vscode";
import { closeTagAt } from "oddity-language-server/edit";

/**
 * Close tags as they are typed in XML: after the `>` of a start tag insert its
 * end tag (cursor stays between), after `</` the name of the open element.
 */
export function registerAutoCloseTags(): vscode.Disposable {
  return vscode.workspace.onDidChangeTextDocument((e) => {
    const editor = vscode.window.activeTextEditor;
    if (
      !editor ||
      editor.document !== e.document ||
      e.document.languageId !== "xml" ||
      e.reason !== undefined || // undo or redo
      e.contentChanges.length !== 1 ||
      !vscode.workspace.getConfiguration("oddity.xml", e.document).get<boolean>("autoCloseTags", true)
    ) {
      return;
    }
    const change = e.contentChanges[0];
    if (change.text !== ">" && change.text !== "/") {
      return;
    }
    const offset = change.rangeOffset + change.text.length;
    const insert = closeTagAt(e.document.getText(), offset);
    if (!insert) {
      return;
    }
    const at = e.document.positionAt(offset);
    // after '>' the cursor stays between the tags; after '</' it moves past the end tag
    const snippet = change.text === ">" ? `$0${insert}` : `${insert}$0`;
    void editor.insertSnippet(new vscode.SnippetString(snippet.replace(/\\/g, "\\\\").replace(/\$(?!0)/g, "\\$").replace(/}/g, "\\}")), at, {
      undoStopBefore: false,
      undoStopAfter: false,
    });
  });
}
