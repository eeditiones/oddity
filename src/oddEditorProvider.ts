import * as vscode from "vscode";
import { parseOdd } from "./oddModel";
import { serializeElementSpec } from "./oddSerialize";
import { ElementSpec, OddMeta, WebviewToHost } from "./oddTypes";

/**
 * A `CustomTextEditorProvider` that presents `.odd` files as a form-based editor
 * while keeping the text document as the single source of truth.
 *
 * Registered with `priority: "option"`, so it never displaces the default text
 * editor; it is opened on demand (command / "Open With"), typically beside the
 * source. Edits are written back surgically: only the changed `<elementSpec>`
 * range is rewritten, leaving the teiHeader, comments, formatting and any
 * unmodeled content untouched.
 */
export class OddEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "oddTools.graphicalEditor";

  /** Guards the self-edit → change-event → reload feedback loop. */
  private editing = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      ],
    };
    // A distinct tab icon to set the graphical editor apart from a text editor.
    panel.iconPath = {
      light: vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "odd-editor-light.svg"
      ),
      dark: vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "odd-editor-dark.svg"
      ),
    };
    panel.webview.html = this.html(panel.webview);

    const post = () => {
      panel.webview.postMessage({ type: "load", model: parseOdd(document.getText()) });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      // Skip reloads triggered by our own surgical edits (preserves field focus);
      // external edits (source editor) do refresh the form.
      if (!this.editing) {
        post();
      }
    });

    const msgSub = panel.webview.onDidReceiveMessage((msg: WebviewToHost) =>
      this.onMessage(document, panel, msg, post)
    );

    panel.onDidDispose(() => {
      changeSub.dispose();
      msgSub.dispose();
    });
  }

  private async onMessage(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    msg: WebviewToHost,
    post: () => void
  ): Promise<void> {
    switch (msg.type) {
      case "ready":
        post();
        return;
      case "updateElementSpec":
        // In-place field edit: splice the spec, leave the form as-is.
        await this.updateElementSpec(document, msg.index, msg.spec);
        return;
      case "addElementSpec":
        await this.addElementSpec(document, msg.ident, msg.mode);
        post();
        return;
      case "deleteElementSpec":
        await this.deleteElementSpec(document, msg.index);
        post();
        return;
      case "updateMeta":
        await this.updateMeta(document, msg.meta);
        post();
        return;
    }
  }

  private async applyEdit(
    edit: (builder: vscode.WorkspaceEdit) => void
  ): Promise<void> {
    const builder = new vscode.WorkspaceEdit();
    edit(builder);
    this.editing = true;
    try {
      await vscode.workspace.applyEdit(builder);
    } finally {
      this.editing = false;
    }
  }

  private async updateElementSpec(
    document: vscode.TextDocument,
    index: number,
    spec: ElementSpec
  ): Promise<void> {
    const text = document.getText();
    const model = parseOdd(text);
    const target = model.elementSpecs[index];
    if (!target?.range) {
      return;
    }
    // Replace from the start of the element's line: the leading whitespace there
    // becomes the element's indent, so serializeElementSpec (which prefixes its
    // first line with that indent) lands exactly, without doubling it.
    const lineStart = text.lastIndexOf("\n", target.range.start - 1) + 1;
    const indent = text.slice(lineStart, target.range.start);
    const xml = serializeElementSpec(indent, model.indentUnit, spec);
    const range = new vscode.Range(
      document.positionAt(lineStart),
      document.positionAt(target.range.end)
    );
    await this.applyEdit((b) => b.replace(document.uri, range, xml));
  }

  private async addElementSpec(
    document: vscode.TextDocument,
    ident: string,
    mode: string
  ): Promise<void> {
    const text = document.getText();
    const model = parseOdd(text);
    if (model.schemaSpecBodyEnd === undefined) {
      return;
    }
    const spec: ElementSpec = { ident, mode, models: [] };
    const xml = serializeElementSpec(model.elementSpecIndent, model.indentUnit, spec);
    const lineStart = text.lastIndexOf("\n", model.schemaSpecBodyEnd - 1) + 1;
    const pos = document.positionAt(lineStart);
    await this.applyEdit((b) => b.insert(document.uri, pos, `${xml}\n`));
  }

  private async deleteElementSpec(
    document: vscode.TextDocument,
    index: number
  ): Promise<void> {
    const text = document.getText();
    const model = parseOdd(text);
    const target = model.elementSpecs[index];
    if (!target?.range) {
      return;
    }
    // Swallow the spec's own line indentation and the trailing newline.
    const start = text.lastIndexOf("\n", target.range.start - 1) + 1;
    let end = target.range.end;
    if (text[end] === "\n") {
      end += 1;
    }
    const range = new vscode.Range(
      document.positionAt(start),
      document.positionAt(end)
    );
    await this.applyEdit((b) => b.delete(document.uri, range));
  }

  private async updateMeta(
    document: vscode.TextDocument,
    meta: Partial<OddMeta>
  ): Promise<void> {
    const text = document.getText();
    const model = parseOdd(text);
    if (!model.metaRange) {
      return;
    }
    let tag = text.slice(model.metaRange.start, model.metaRange.end);
    if ("source" in meta) tag = setAttribute(tag, "source", meta.source);
    if ("ident" in meta) tag = setAttribute(tag, "ident", meta.ident);
    if ("ns" in meta) tag = setAttribute(tag, "ns", meta.ns);
    const range = new vscode.Range(
      document.positionAt(model.metaRange.start),
      document.positionAt(model.metaRange.end)
    );
    await this.applyEdit((b) => b.replace(document.uri, range, tag));
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource} data:`,
      // CodeMirror injects its own <style> elements at runtime.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${style}" rel="stylesheet" />
  <title>ODD Editor</title>
</head>
<body>
  <odd-editor></odd-editor>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

/** Insert, replace, or (when value is empty) remove an attribute in a start tag. */
function setAttribute(tag: string, name: string, value?: string): string {
  const re = new RegExp(`\\s+${name}\\s*=\\s*"[^"]*"`);
  if (!value) {
    return tag.replace(re, "");
  }
  const attr = ` ${name}="${value}"`;
  if (re.test(tag)) {
    return tag.replace(re, attr);
  }
  // Insert before the closing '>' (or '/>').
  return tag.replace(/\s*\/?>$/, (close) => `${attr}${close}`);
}

function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
