import * as path from "path";
import * as vscode from "vscode";

export const OUTPUT_SCHEME = "opm-output";

/**
 * Read-only documents holding a preview's latest opm output, so it can be read
 * in a real editor (highlighting, search, folding). A document follows its
 * preview: each refresh replaces its text.
 */
export class OutputDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(
    OUTPUT_SCHEME,
    this
  );

  /** URI of a preview's output; the extension picks the editor's language. */
  static uri(previewId: string, xmlFile: string, mode: string): vscode.Uri {
    const ext = mode === "markdown" ? "md" : mode === "typst" ? "typ" : "html";
    const name = `${path.basename(xmlFile, path.extname(xmlFile))}.${mode}.${ext}`;
    return vscode.Uri.from({ scheme: OUTPUT_SCHEME, path: `/${previewId}/${name}` });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  set(uri: vscode.Uri, text: string): void {
    const key = uri.toString();
    if (this.contents.get(key) !== text) {
      this.contents.set(key, text);
      this.changed.fire(uri);
    }
  }

  async open(uri: vscode.Uri, text: string): Promise<void> {
    this.set(uri, text);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
  }

  /** Forget a closed preview's outputs. */
  forget(previewId: string): void {
    for (const key of this.contents.keys()) {
      if (vscode.Uri.parse(key).path.startsWith(`/${previewId}/`)) {
        this.contents.delete(key);
      }
    }
  }

  dispose(): void {
    this.registration.dispose();
    this.changed.dispose();
  }
}
