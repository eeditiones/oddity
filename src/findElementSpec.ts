import * as vscode from "vscode";
import { resolveTeiDebugJump } from "./debugSignature";
import { getActiveOddEditor } from "./oddEditorPanels";
import { parseOdd } from "./oddModel";

export function registerFindElementSpec(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand("oddTools.findElementSpec", () =>
    showElementSpecPicker()
  );
}

type SpecPickItem = vscode.QuickPickItem & {
  index: number;
  ident: string;
};

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

  const items: SpecPickItem[] = model.elementSpecs.map((spec, index) => ({
    label: spec.ident || `(element ${index + 1})`,
    description: spec.mode,
    index,
    ident: spec.ident,
  }));

  const qp = vscode.window.createQuickPick<SpecPickItem>();
  qp.title = "Go to elementSpec";
  qp.placeholder = "Filter by ident, or paste a TEI class (tei-gap3)…";
  qp.items = items;
  qp.matchOnDescription = true;

  const choice = await new Promise<
    | { kind: "item"; item: SpecPickItem }
    | { kind: "jump"; ident: string; index: number; modelPath?: number[] }
    | undefined
  >((resolve) => {
    let settled = false;
    const finish = (
      value:
        | { kind: "item"; item: SpecPickItem }
        | { kind: "jump"; ident: string; index: number; modelPath?: number[] }
        | undefined
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      qp.hide();
      qp.dispose();
    };

    qp.onDidAccept(() => {
      const jump = resolveTeiDebugJump(qp.value, model);
      if (jump) {
        if (!jump.ok) {
          vscode.window.showInformationMessage(jump.reason);
          return;
        }
        finish({
          kind: "jump",
          ident: jump.ident,
          index: jump.index,
          modelPath: jump.modelPath,
        });
        return;
      }
      const item = qp.selectedItems[0];
      finish(item ? { kind: "item", item } : undefined);
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });

  if (!choice) {
    return;
  }

  if (choice.kind === "jump") {
    entry.panel.webview.postMessage({
      type: "selectIdent",
      ident: choice.ident,
      index: choice.index,
      modelPath: choice.modelPath,
    });
    return;
  }

  entry.panel.webview.postMessage({
    type: "selectIdent",
    ident: choice.item.ident || undefined,
    index: choice.item.index,
  });
}
