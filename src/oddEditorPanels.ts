import * as vscode from "vscode";

interface PanelEntry {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
}

export interface ElementSpecSelection {
  ident?: string;
  index: number;
}

const panels = new Map<string, PanelEntry>();
const pendingSelection = new Map<string, ElementSpecSelection>();
let lastActiveUri: string | undefined;

export function registerOddEditorPanel(
  document: vscode.TextDocument,
  panel: vscode.WebviewPanel
): () => void {
  const key = document.uri.toString();
  panels.set(key, { panel, document });

  const viewSub = panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) {
      lastActiveUri = key;
    }
  });
  if (panel.active) {
    lastActiveUri = key;
  }

  return () => {
    viewSub.dispose();
    panels.delete(key);
    if (lastActiveUri === key) {
      lastActiveUri = undefined;
    }
  };
}

/** The graphical editor panel for a document, if open. */
export function getOddEditorPanel(uri: vscode.Uri): PanelEntry | undefined {
  return panels.get(uri.toString());
}

/** Remember which elementSpec to select when the graphical editor opens. */
export function setPendingElementSpecSelection(
  uri: vscode.Uri,
  selection: ElementSpecSelection
): void {
  pendingSelection.set(uri.toString(), selection);
}

/** Take the pending elementSpec selection for a document, if any. */
export function consumePendingElementSpecSelection(
  uri: vscode.Uri
): ElementSpecSelection | undefined {
  const key = uri.toString();
  const selection = pendingSelection.get(key);
  if (selection) {
    pendingSelection.delete(key);
  }
  return selection;
}

/** The graphical editor panel for the active tab, if any. */
export function getActiveOddEditor(): PanelEntry | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
  if (activeUri) {
    const entry = panels.get(activeUri);
    if (entry) {
      return entry;
    }
  }
  if (lastActiveUri) {
    return panels.get(lastActiveUri);
  }
  return undefined;
}
