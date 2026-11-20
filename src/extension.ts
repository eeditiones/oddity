import * as vscode from "vscode";
import { registerAddElementSpec } from "./addElementSpec";
import { OddEditorProvider } from "./oddEditorProvider";
import { registerFindElementSpec } from "./findElementSpec";
import { registerOpenGraphicalEditorAtElementSpec } from "./openGraphicalEditorAtElementSpec";
import { registerRecompileOdd } from "./recompileOdd";
import { removeLegacySchemaBinding } from "./legacySchemaBinding";
import { registerOpmPreview } from "./opm/previewPanel";
import { OpmHelper, opmLog } from "./opm/helper";
import { registerShowOddRule } from "./opm/oddRule";
import { startXmlLanguageClient, stopXmlLanguageClient } from "./xmlLanguageClient";
import { registerAutoCloseTags } from "./autoCloseTags";
import { registerSchemaCommands } from "./schemaCommands";
import { registerXmlElementCommands } from "./xmlElementCommands";

export function activate(context: vscode.ExtensionContext): void {
  // One opm process for the preview and Show ODD Rule
  const opm = new OpmHelper(context);
  context.subscriptions.push(
    startXmlLanguageClient(context),
    registerAutoCloseTags(),
    registerSchemaCommands(context),
    registerXmlElementCommands(),
    opmLog(),
    registerAddElementSpec(context),
    registerRecompileOdd(context),
    registerFindElementSpec(context),
    registerOpenGraphicalEditorAtElementSpec(context),
    registerOpmPreview(context, opm),
    registerShowOddRule(context, opm),
    opm,
    vscode.window.registerCustomEditorProvider(
      OddEditorProvider.viewType,
      new OddEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand("oddity.openGraphicalEditor", (uri?: vscode.Uri) => {
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

  // Until 0.6 ODDity bound an XSD to .odd files through Red Hat's xml.fileAssociations
  removeLegacySchemaBinding().catch((err) =>
    console.error("[ODDity] removing the old schema binding failed:", err)
  );
}

export function deactivate(): Thenable<void> | undefined {
  return stopXmlLanguageClient();
}
