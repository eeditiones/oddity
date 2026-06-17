import * as vscode from "vscode";
import { OddDocumentSymbolProvider } from "./oddOutline";
import { registerAddElementSpec } from "./addElementSpec";
import { OddEditorProvider } from "./oddEditorProvider";
import { registerFindElementSpec } from "./findElementSpec";
import { registerOpenGraphicalEditorAtElementSpec } from "./openGraphicalEditorAtElementSpec";
import { registerRecompileOdd } from "./recompileOdd";
import { ensureSchemaBinding } from "./schemaBinding";

const ODD_SELECTOR: vscode.DocumentSelector = {
  language: "xml",
  pattern: "**/*.odd",
};

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      ODD_SELECTOR,
      new OddDocumentSymbolProvider()
    ),
    registerAddElementSpec(context),
    registerRecompileOdd(context),
    registerFindElementSpec(context),
    registerOpenGraphicalEditorAtElementSpec(context),
    vscode.window.registerCustomEditorProvider(
      OddEditorProvider.viewType,
      new OddEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand("oddTools.openGraphicalEditor", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) {
        vscode.commands.executeCommand(
          "vscode.openWith",
          target,
          OddEditorProvider.viewType,
          vscode.ViewColumn.Active
        );
      }
    })
  );

  const bind = () =>
    ensureSchemaBinding(context).catch((err) =>
      console.error("[TEI ODD Tools] schema binding failed:", err)
    );

  bind();

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.fileName.endsWith(".odd")) {
        bind();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("oddTools.autoBindSchema")) {
        bind();
      }
    })
  );
}

export function deactivate(): void {
  // no-op
}
