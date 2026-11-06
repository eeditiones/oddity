import * as vscode from "vscode";
import { parseOdd } from "./oddModel";
import { spliceElementSpec } from "./oddSplice";
import {
  insertElementSpec,
  insertElementSpecFromClipboard,
} from "./elementSpecInsert";
import {
  getOddClipboard,
  registerOddClipboardPeer,
  setOddClipboard,
} from "./oddClipboard";
import {
  consumePendingElementSpecSelection,
  getOddEditorPanel,
  registerOddEditorPanel,
} from "./oddEditorPanels";
import { showElementSpecPicker } from "./findElementSpec";
import { ElementSpec, OddMeta, WebviewToHost } from "./oddTypes";
import { isRecompileEligible } from "./existConfig";
import {
  formatXmlErrors,
  getXmlWellFormednessErrors,
} from "./oddXmlDiagnostics";

/**
 * A `CustomTextEditorProvider` that presents `.odd` files as a form-based editor
 * while keeping the text document as the single source of truth.
 *
 * Registered with `priority: "option"`, so it never displaces the default text
 * editor; it is opened on demand (command / "Open With"), typically beside the
 * source. The form reloads on every document change and when XML validation
 * updates (not only when the panel gains focus). Edits are written back
 * surgically: within the changed `<elementSpec>`, only the `ident` / `mode`
 * attributes, the element's own `<desc>`, and the rule elements are rewritten
 * (see {@link spliceElementSpec}), so the teiHeader, comments, formatting and
 * unmodeled markup stay as they are.
 */
export class OddEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "oddity.graphicalEditor";

  /** Guards the self-edit → change-event → reload feedback loop. */
  private editing = false;
  /**
   * Ignore document-change reloads until this timestamp. VS Code may emit
   * `onDidChangeTextDocument` after `applyEdit` resolves (and after a
   * microtask), which would otherwise push a stale `load` into the webview
   * while the user is still typing.
   */
  private suppressReloadUntil = 0;
  /** Resolvers for `onWillSaveTextDocument` waiting on webview flush. */
  private readonly flushResolvers = new Map<string, () => void>();

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onWillSaveTextDocument((e) => this.onWillSave(e))
    );
  }

  private onWillSave(e: vscode.TextDocumentWillSaveEvent): void {
    if (!e.document.fileName.endsWith(".odd")) {
      return;
    }
    const entry = getOddEditorPanel(e.document.uri);
    if (!entry) {
      return;
    }
    e.waitUntil(this.waitForWebviewFlush(e.document.uri, entry.panel));
  }

  private waitForWebviewFlush(
    uri: vscode.Uri,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const key = uri.toString();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.flushResolvers.delete(key)) {
          resolve();
        }
      }, 3000);
      this.flushResolvers.set(key, () => {
        clearTimeout(timeout);
        resolve();
      });
      panel.webview.postMessage({ type: "flush" });
    });
  }

  private resolveFlush(uri: vscode.Uri): void {
    const resolve = this.flushResolvers.get(uri.toString());
    if (resolve) {
      this.flushResolvers.delete(uri.toString());
      resolve();
    }
  }

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
        "oddity_icon_light.svg"
      ),
      dark: vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "oddity_icon_dark.svg"
      ),
    };
    panel.webview.html = this.html(panel.webview);

    const post = (selectIdent?: string) => {
      const model = parseOdd(document.getText());
      model.xmlError = formatXmlErrors(
        getXmlWellFormednessErrors(document.uri)
      );
      panel.webview.postMessage({
        type: "load",
        model,
        selectIdent,
        canRecompile: isRecompileEligible(document.uri.fsPath),
      });
    };

    const reloadIfExternal = () => {
      if (Date.now() < this.suppressReloadUntil) {
        return;
      }
      post();
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        reloadIfExternal();
      }
    });

    // Refresh when the XML language service updates validation (may lag edits).
    const diagSub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.toString() === document.uri.toString())) {
        reloadIfExternal();
      }
    });

    const msgSub = panel.webview.onDidReceiveMessage((msg: WebviewToHost) =>
      this.onMessage(document, panel, msg, post, applyElementSpecUpdate)
    );
    const unregClip = registerOddClipboardPeer(panel.webview);
    const unregPanel = registerOddEditorPanel(document, panel);

    let lastAppliedGeneration = 0;
    let latestUpdate:
      | { index: number; spec: ElementSpec; generation: number }
      | undefined;
    let drainingUpdates = false;

    const applyElementSpecUpdate = async (
      index: number,
      spec: ElementSpec,
      generation: number
    ): Promise<void> => {
      if (generation <= lastAppliedGeneration) {
        panel.webview.postMessage({
          type: "editApplied",
          generation: lastAppliedGeneration,
        });
        return;
      }
      latestUpdate = { index, spec, generation };
      if (drainingUpdates) {
        return;
      }
      drainingUpdates = true;
      this.suppressReloadUntil = Math.max(
        this.suppressReloadUntil,
        Date.now() + 500
      );
      try {
        while (latestUpdate) {
          const update = latestUpdate;
          latestUpdate = undefined;
          if (update.generation <= lastAppliedGeneration) {
            continue;
          }
          await this.updateElementSpec(document, update.index, update.spec);
          lastAppliedGeneration = update.generation;
        }
      } finally {
        drainingUpdates = false;
        panel.webview.postMessage({
          type: "editApplied",
          generation: lastAppliedGeneration,
        });
      }
    };

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("oddity.editorFontSize")) {
        panel.webview.postMessage({ type: "fontSize", css: fontSizeCss() });
      }
    });

    panel.onDidDispose(() => {
      configSub.dispose();
      changeSub.dispose();
      diagSub.dispose();
      msgSub.dispose();
      unregClip();
      unregPanel();
    });
  }

  private async onMessage(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    msg: WebviewToHost,
    post: () => void,
    applyElementSpecUpdate: (
      index: number,
      spec: ElementSpec,
      generation: number
    ) => Promise<void>
  ): Promise<void> {
    switch (msg.type) {
      case "ready": {
        post();
        const pending = consumePendingElementSpecSelection(document.uri);
        if (pending) {
          panel.webview.postMessage({
            type: "selectIdent",
            ident: pending.ident,
            index: pending.index,
          });
        }
        return;
      }
      case "updateElementSpec":
        await applyElementSpecUpdate(msg.index, msg.spec, msg.generation);
        return;
      case "flushDone":
        this.resolveFlush(document.uri);
        return;
      case "addElementSpec":
        await this.addElementSpec(document, msg.ident, post);
        return;
      case "deleteElementSpec":
        await this.deleteElementSpec(document, msg.index);
        post();
        return;
      case "updateMeta":
        await this.updateMeta(document, msg.meta);
        post();
        return;
      case "copyClip":
        setOddClipboard(msg.clip);
        return;
      case "pasteElementSpec":
        await this.pasteElementSpec(document, post);
        return;
      case "findElementSpec":
        await showElementSpecPicker();
        return;
      case "recompileOdd":
        await vscode.commands.executeCommand(
          "oddity.recompileOdd",
          document.uri
        );
        return;
    }
  }

  private async pasteElementSpec(
    document: vscode.TextDocument,
    post: (selectIdent?: string) => void
  ): Promise<void> {
    const clip = getOddClipboard();
    if (!clip || clip.kind !== "elementSpec") {
      return;
    }
    this.editing = true;
    try {
      const result = await insertElementSpecFromClipboard(document, clip.data);
      if (result) {
        post(result.ident);
      }
    } finally {
      this.editing = false;
    }
  }

  private async applyEdit(
    edit: (builder: vscode.WorkspaceEdit) => void
  ): Promise<void> {
    const builder = new vscode.WorkspaceEdit();
    edit(builder);
    this.editing = true;
    this.suppressReloadUntil = Math.max(
      this.suppressReloadUntil,
      Date.now() + 250
    );
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
    if (getXmlWellFormednessErrors(document.uri).length > 0) {
      return;
    }
    const text = document.getText();
    const model = parseOdd(text);
    const target = model.elementSpecs[index];
    if (!target?.range) {
      return;
    }
    // spliceElementSpec prefixes its result with the line's indent. Only the
    // leading whitespace of the line counts as indent: when other markup
    // precedes the spec on its line, that markup is kept and the prefix dropped.
    const start = target.range.start;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const indent = (/^[ \t]*/.exec(text.slice(lineStart, start)) ?? [""])[0];
    const xml = spliceElementSpec(
      indent,
      model.indentUnit,
      spec,
      text.slice(start, target.range.end)
    ).slice(indent.length);
    if (text.slice(start, target.range.end) === xml) {
      return;
    }
    const range = new vscode.Range(
      document.positionAt(start),
      document.positionAt(target.range.end)
    );
    await this.applyEdit((b) => b.replace(document.uri, range, xml));
  }

  private async addElementSpec(
    document: vscode.TextDocument,
    ident: string | undefined,
    post: (selectIdent?: string) => void
  ): Promise<void> {
    this.editing = true;
    try {
      const result = await insertElementSpec(this.context, document, {
        ident: ident?.trim() || undefined,
      });
      if (result) {
        post(result.ident);
      }
    } finally {
      this.editing = false;
    }
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
    // A spec on lines of its own goes with its indentation and trailing
    // newline; one sharing its line with other markup leaves that markup alone.
    const lineStart = text.lastIndexOf("\n", target.range.start - 1) + 1;
    const ownLine = /^[ \t]*$/.test(text.slice(lineStart, target.range.start));
    const start = ownLine ? lineStart : target.range.start;
    let end = target.range.end;
    if (ownLine && text[end] === "\n") {
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
<html lang="en" style="--oddity-font-size: ${fontSizeCss()}">
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

/**
 * Font size for the form's inputs and code fields: the `oddity.editorFontSize`
 * setting, or the VS Code editor font size when it is 0 or unset.
 */
function fontSizeCss(): string {
  const size = vscode.workspace
    .getConfiguration("oddity")
    .get<number>("editorFontSize", 0);
  return size > 0 ? `${size}px` : "var(--vscode-editor-font-size, 13px)";
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
