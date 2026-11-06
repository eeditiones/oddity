import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { OpmHelper } from "./helper";
import { OutputDocuments } from "./outputDocuments";
import { findOpmProject, isPreviewable } from "./project";
import { isPreviewMode, PREVIEW_MODES, previewPage, PreviewMode } from "./render";
import { PreviewServer } from "./server";

const DEBOUNCE_MS = 400;

/**
 * "Open opm Preview to the Side": a panel beside an XML file of an opm
 * project showing it transformed by opm, refreshed while you type and
 * whenever a file of the project (ODD, CSS, templates, opm.toml) is saved.
 */
export function registerOpmPreview(context: vscode.ExtensionContext): vscode.Disposable {
  const helper = new OpmHelper(context);
  const server = new PreviewServer(context.extensionPath);
  const outputs = new OutputDocuments();
  const panels = new Map<string, OpmPreview>();

  const updateContext = () => {
    const doc = vscode.window.activeTextEditor?.document;
    vscode.commands.executeCommand(
      "setContext",
      "oddity.inOpmProject",
      !!doc && isPreviewable(doc)
    );
  };
  updateContext();

  return vscode.Disposable.from(
    helper,
    server,
    outputs,
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.commands.registerCommand("oddity.opmPreview", async (uri?: vscode.Uri) => {
      const doc = uri
        ? await vscode.workspace.openTextDocument(uri)
        : vscode.window.activeTextEditor?.document;
      const root = doc && findOpmProject(doc.uri);
      if (!doc || !root) {
        vscode.window.showInformationMessage(
          "The opm preview works on XML files in a folder with an opm.toml (an opm project)."
        );
        return;
      }
      const key = doc.uri.toString();
      const existing = panels.get(key);
      if (existing) {
        existing.reveal();
        return;
      }
      helper.allowInstallPrompt();
      const preview = new OpmPreview(context, helper, server, outputs, doc, root, () => panels.delete(key));
      panels.set(key, preview);
    }),
    vscode.commands.registerCommand("oddity.opmRestart", () => {
      helper.allowInstallPrompt();
      helper.restart();
      panels.forEach((p) => p.refresh());
    }),
    { dispose: () => panels.forEach((p) => p.dispose()) }
  );
}

class OpmPreview {
  private readonly panel: vscode.WebviewPanel;
  private readonly id = randomBytes(8).toString("hex");
  private readonly subs: vscode.Disposable[] = [];
  private mode: PreviewMode;
  private timer?: NodeJS.Timeout;
  /** Newest request; replies to older ones are dropped. */
  private seq = 0;
  private ready = false;
  /** Latest output, for "Open output". */
  private output?: { mode: PreviewMode; text: string };

  constructor(
    context: vscode.ExtensionContext,
    private readonly helper: OpmHelper,
    private readonly server: PreviewServer,
    private readonly outputs: OutputDocuments,
    private readonly doc: vscode.TextDocument,
    private readonly root: string,
    private readonly onDispose: () => void
  ) {
    const configured = vscode.workspace.getConfiguration("oddity.opm").get("defaultMode");
    this.mode = isPreviewMode(configured) ? configured : "web";
    this.panel = vscode.window.createWebviewPanel(
      "oddity.opmPreview",
      `Preview ${path.basename(doc.fileName)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "media", "oddity_icon_light.svg"),
      dark: vscode.Uri.joinPath(context.extensionUri, "media", "oddity_icon_dark.svg"),
    };
    void this.server.origin().then((origin) => {
      this.panel.webview.html = previewHtml(origin, this.mode);
    });

    this.subs.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.doc && e.contentChanges.length) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((saved) => {
        // ODD, CSS, templates, opm.toml, registers: anything the output may use
        if (saved !== this.doc && isInside(saved.uri.fsPath, this.root)) {
          this.schedule();
        }
      })
    );
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.server.remove(this.id);
    this.outputs.forget(this.id);
    this.subs.forEach((s) => s.dispose());
    this.subs.length = 0;
    this.onDispose();
    this.panel.dispose();
  }

  private onMessage(msg: { type?: string; mode?: string }): void {
    if (msg.type === "ready") {
      this.ready = true;
      void this.refresh();
    } else if (msg.type === "mode" && isPreviewMode(msg.mode)) {
      this.mode = msg.mode;
      void this.refresh();
    } else if (msg.type === "openOutput" && this.output) {
      const { mode, text } = this.output;
      void this.outputs.open(OutputDocuments.uri(this.id, this.doc.fileName, mode), text);
    } else if (msg.type === "restart") {
      void vscode.commands.executeCommand("oddity.opmRestart");
    } else if (msg.type === "log") {
      this.helper.log.show(true);
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
  }

  async refresh(): Promise<void> {
    if (!this.ready) {
      return;
    }
    clearTimeout(this.timer);
    const seq = ++this.seq;
    const mode = this.mode;
    const started = Date.now();
    this.post({ type: "busy" });
    const result = await this.helper.transform({
      root: this.root,
      file: this.doc.uri.fsPath,
      text: this.doc.getText(),
      mode,
    });
    if (seq !== this.seq) {
      return;
    }
    if (!result.ok) {
      if (result.traceback) {
        this.helper.log.appendLine(result.traceback);
      }
      this.post({ type: "error", message: result.error });
      return;
    }
    this.output = { mode, text: result.output };
    // An output tab already open for this mode follows the preview
    this.outputs.set(OutputDocuments.uri(this.id, this.doc.fileName, mode), result.output);
    const url = await this.server.publish(this.id, {
      html: previewPage(mode, result.output, this.server.pagedJsPath),
      assets: result.assets,
      docDir: path.dirname(this.doc.uri.fsPath),
      root: this.root,
    });
    this.post({
      type: "show",
      url: `${url.toString(true)}?v=${seq}`,
      mode,
      elapsed: Date.now() - started,
    });
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }
}

function isInside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The codicon "go-to-file", inline: the panel loads no icon font. */
const GO_TO_FILE = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.58594 1.00098C8.98394 1.00098 9.36646 1.15943 9.64746 1.44043L12.5605 4.35352C12.8415 4.63552 13.001 5.01704 13.001 5.41504V13.001C13.001 14.106 12.106 15.001 11.001 15.001H5.00098C3.89599 15.001 3.00098 14.106 3.00098 13.001V6.00098H4.00098V13.001C4.00098 13.553 4.44899 14.001 5.00098 14.001H11.001C11.553 14.001 12.001 13.553 12.001 13.001V6.00098H9.50098C8.67299 6.00096 8.00098 5.32897 8.00098 4.50098V2.00098C7.99198 1.97699 7.98265 1.9527 7.97266 1.92871C7.89674 1.74704 7.78717 1.5812 7.64746 1.44238L7.20605 1.00098H8.58594ZM9 4.5C9 4.776 9.224 5 9.5 5H11.793L9 2.20703V4.5Z"/><path d="M4.5 0C4.63299 0 4.75952 0.0534683 4.85352 0.147461L6.85352 2.14746C6.90042 2.19336 6.93789 2.24775 6.96289 2.30859C6.98789 2.36959 7.00097 2.43498 7.00098 2.50098C7.00098 2.56698 6.98789 2.63236 6.96289 2.69336C6.93789 2.75323 6.90043 2.80956 6.85352 2.85547L4.85352 4.85547C4.75956 4.94917 4.63278 5.00195 4.5 5.00195C4.36722 5.00195 4.24044 4.94917 4.14648 4.85547C4.05248 4.76147 3.99902 4.63398 3.99902 4.50098C3.99903 4.36799 4.05249 4.24146 4.14648 4.14746L5.29297 3.00098H2.5C2.10201 3.00098 1.72045 3.15944 1.43945 3.44043C1.15846 3.72242 1.00001 4.10298 1 4.50098V5.50098C1 5.63398 0.947516 5.76147 0.853516 5.85547C0.759563 5.94817 0.632774 6.00098 0.5 6.00098C0.367225 6.00098 0.240437 5.94917 0.146484 5.85547C0.0534844 5.76147 0 5.63398 0 5.50098V4.50098C6.17892e-06 3.83799 0.263427 3.20239 0.732422 2.7334C1.20142 2.26441 1.83701 2.00098 2.5 2.00098H5.29297L4.14648 0.855469C4.05248 0.761469 3.99902 0.633977 3.99902 0.500977C3.99903 0.367985 4.05249 0.241455 4.14648 0.147461C4.24048 0.0534683 4.36701 0 4.5 0Z"/></svg>`;

function previewHtml(origin: string, mode: PreviewMode): string {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    `default-src 'none'`,
    `frame-src ${origin}`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const options = PREVIEW_MODES.map(
    (m) => `<option value="${m}"${m === mode ? " selected" : ""}>${m}</option>`
  ).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .bar { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent); flex: none; }
  select, button { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 2px 6px; }
  button { cursor: pointer; }
  #open { display: inline-flex; align-items: center; padding: 3px 4px; }
  #open svg { flex: none; }
  button:disabled { opacity: .5; cursor: default; }
  .status { margin-left: auto; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status.busy::before { content: "⟳ "; }
  main { position: relative; flex: 1; min-height: 0; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
  .error { position: absolute; inset: 0; overflow: auto; padding: 12px 16px; background: var(--vscode-editor-background); }
  .error pre { margin: 0; padding: 8px; white-space: pre-wrap; border-left: 3px solid var(--vscode-errorForeground); background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family, monospace); }
  .error a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="bar">
  <label>Output <select id="mode">${options}</select></label>
  <button id="open" title="Open output in editor" aria-label="Open output in editor" disabled>${GO_TO_FILE}</button>
  <span class="status" id="status">Starting opm…</span>
</div>
<main>
  <iframe id="frame" title="opm output"></iframe>
  <div class="error" id="error" hidden>
    <p><strong>opm could not transform this document.</strong> The preview shows the last good output once it can.</p>
    <pre id="message"></pre>
    <p><a id="log">Show the opm log</a> · <a id="restart">Restart opm</a></p>
  </div>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const frame = $("frame"), status = $("status");
  let elapsed = 0, hasOutput = false;

  $("open").onclick = () => vscode.postMessage({ type: "openOutput" });
  $("mode").onchange = (e) => vscode.postMessage({ type: "mode", mode: e.target.value });
  $("log").onclick = () => vscode.postMessage({ type: "log" });
  $("restart").onclick = () => vscode.postMessage({ type: "restart" });

  function setStatus(text, busy) {
    status.textContent = text;
    status.classList.toggle("busy", !!busy);
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    // Messages from the preview frame
    if (e.source === frame.contentWindow && m.oddityPreview) {
      if (m.oddityPreview === "done") {
        setStatus("Up to date · " + elapsed + " ms" + (m.pages ? " · " + m.pages + " pages" : ""));
      } else {
        setStatus(m.message || "Preview error");
      }
      return;
    }
    switch (m.type) {
      case "busy":
        setStatus(hasOutput ? "Updating…" : "Transforming…", true);
        break;
      case "show":
        hasOutput = true;
        elapsed = m.elapsed;
        $("error").hidden = true;
        $("open").disabled = false;
        frame.src = m.url;
        setStatus(m.mode === "print" ? "Paginating…" : "Up to date · " + elapsed + " ms", m.mode === "print");
        break;
      case "error":
        $("message").textContent = m.message;
        $("error").hidden = false;
        setStatus("Error");
        break;
    }
  });
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
