import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CollectionPreview, collectionFolders } from "./collectionPreview";
import { OpmHelper } from "./helper";
import { locateTypst } from "./locate";
import { OutputDocuments } from "./outputDocuments";
import { findOpmProject, isPreviewable } from "./project";
import { chunkPage, isPreviewMode, PREVIEW_MODES, previewPage, PreviewMode, typstPage } from "./render";
import { PreviewServer } from "./server";

const DEBOUNCE_MS = 400;

/**
 * "Open opm Preview to the Side": a panel beside an XML file of an opm
 * project showing it transformed by opm, refreshed while you type and
 * whenever a file of the project (ODD, CSS, templates, opm.toml) is saved.
 * The chunk mode publishes a folder of pages instead of one, from the saved
 * file, so it refreshes on save only. The typst mode, offered when the typst
 * command is found, shows the pages Typst compiles, as SVG images.
 */
export function registerOpmPreview(context: vscode.ExtensionContext): vscode.Disposable {
  const helper = new OpmHelper(context);
  const server = new PreviewServer(context.extensionPath);
  const outputs = new OutputDocuments();
  const panels = new Map<string, OpmPreview>();
  const collections = new Map<string, CollectionPreview>();

  const updateContext = () => {
    const doc = vscode.window.activeTextEditor?.document;
    vscode.commands.executeCommand(
      "setContext",
      "oddity.inOpmProject",
      !!doc && isPreviewable(doc)
    );
  };
  updateContext();

  // The folders the explorer offers a collection preview on
  let scan: NodeJS.Timeout | undefined;
  const updateFolders = () => {
    clearTimeout(scan);
    scan = setTimeout(async () => {
      const folders = await collectionFolders();
      void vscode.commands.executeCommand("setContext", "oddity.opmCollections", folders);
    }, 1000);
  };
  updateFolders();
  const watcher = vscode.workspace.createFileSystemWatcher("**/{opm.toml,*.xml}", false, true, false);

  return vscode.Disposable.from(
    watcher,
    watcher.onDidCreate(updateFolders),
    watcher.onDidDelete(updateFolders),
    vscode.workspace.onDidChangeWorkspaceFolders(updateFolders),
    { dispose: () => clearTimeout(scan) },
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
    vscode.commands.registerCommand("oddity.opmPreviewCollection", (uri?: vscode.Uri) => {
      const root = uri && findOpmProject(vscode.Uri.joinPath(uri, "_"));
      if (!uri || !root) {
        vscode.window.showInformationMessage(
          "The collection preview works on folders in a folder with an opm.toml (an opm project)."
        );
        return;
      }
      const key = uri.toString();
      const existing = collections.get(key);
      if (existing) {
        existing.reveal();
        return;
      }
      helper.allowInstallPrompt();
      collections.set(
        key,
        new CollectionPreview(context, helper, server, uri.fsPath, root, () => collections.delete(key))
      );
    }),
    // Title-bar buttons of the preview; VS Code's own command does the work
    ...["oddity.opmMaximize", "oddity.opmRestore"].map((id) =>
      vscode.commands.registerCommand(id, () =>
        vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup")
      )
    ),
    vscode.commands.registerCommand("oddity.opmRestart", () => {
      helper.allowInstallPrompt();
      helper.restart();
      panels.forEach((p) => p.restarted());
      collections.forEach((p) => p.restarted());
    }),
    {
      dispose: () => {
        panels.forEach((p) => p.dispose());
        collections.forEach((p) => p.dispose());
      },
    }
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
  /** Where chunk runs and Typst write their pages; removed with the panel. */
  private readonly tmpDir = path.join(os.tmpdir(), "oddity-preview", this.id);
  /** The typst command; without it there is no typst mode. */
  private typst = locateTypst();

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
    this.mode = isPreviewMode(configured) && this.available().includes(configured) ? configured : "web";
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
    void this.render();

    this.subs.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document !== this.doc || !e.contentChanges.length) {
          return;
        }
        if (this.mode === "chunk") {
          this.post({ type: "stale", dirty: this.doc.isDirty });
        } else {
          this.schedule();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((saved) => {
        // The document itself only matters to chunk, which reads it from disk;
        // otherwise ODD, CSS, templates, opm.toml, registers: anything the
        // output may use
        if (saved === this.doc ? this.mode === "chunk" : isInside(saved.uri.fsPath, this.root)) {
          this.schedule();
        }
      })
    );
  }

  private available(): PreviewMode[] {
    return PREVIEW_MODES.filter((m) => m !== "typst" || this.typst);
  }

  /** (Re)build the panel; it asks for the output once it has loaded. */
  private async render(): Promise<void> {
    const origin = await this.server.origin();
    this.ready = false;
    this.panel.webview.html = previewHtml(origin, this.mode, this.available());
  }

  /** The opm process restarted: look for typst again (it may just have been installed). */
  restarted(): void {
    const had = !!this.typst;
    this.typst = locateTypst();
    if (had === !!this.typst) {
      void this.refresh();
      return;
    }
    if (!this.typst && this.mode === "typst") {
      this.mode = "web";
    }
    void this.render();
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.server.remove(this.id);
    this.outputs.forget(this.id);
    fs.rm(this.tmpDir, { recursive: true, force: true }, () => undefined);
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
    } else if (msg.type === "exportPdf") {
      void this.exportPdf();
    } else if (msg.type === "restart") {
      void vscode.commands.executeCommand("oddity.opmRestart");
    } else if (msg.type === "log") {
      this.helper.log.show(true);
    }
  }

  private async exportPdf(): Promise<void> {
    const typst = this.typst;
    if (!typst) {
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(this.doc.fileName.replace(/\.[^./\\]*$/, "") + ".pdf"),
      filters: { PDF: ["pdf"] },
    });
    if (!target) {
      return;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Exporting PDF…" },
      () =>
        this.helper.transform({
          root: this.root,
          file: this.doc.uri.fsPath,
          mode: "typst",
          text: this.doc.getText(),
          typst,
          pdf: target.fsPath,
        })
    );
    if (!result.ok) {
      if (result.traceback) {
        this.helper.log.appendLine(result.traceback);
      }
      void vscode.window.showErrorMessage(`PDF export failed: ${result.error}`);
      return;
    }
    const open = "Open";
    if ((await vscode.window.showInformationMessage(`Wrote ${path.basename(target.fsPath)}`, open)) === open) {
      void vscode.env.openExternal(target);
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
    const file = this.doc.uri.fsPath;
    const text = this.doc.getText();
    const result = await this.helper.transform(
      mode === "chunk"
        ? { root: this.root, file, mode, out: path.join(this.tmpDir, "chunk") }
        : mode === "typst" && this.typst
          ? { root: this.root, file, mode, text, typst: this.typst, out: path.join(this.tmpDir, "typst") }
          : { root: this.root, file, mode, text }
    );
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
    const docDir = path.dirname(file);
    let url: vscode.Uri;
    if ("pdf" in result) {
      return;
    }
    if ("pages" in result) {
      this.output = { mode, text: result.output };
      this.outputs.set(OutputDocuments.uri(this.id, this.doc.fileName, mode), result.output);
      url = await this.server.publish(this.id, {
        html: typstPage(result.pages, seq),
        dir: result.dir,
        docDir,
        root: this.root,
      });
    } else if ("dir" in result) {
      this.output = undefined;
      url = await this.server.publish(this.id, {
        dir: result.dir,
        landing: result.landing,
        page: chunkPage,
        docDir,
        root: this.root,
      });
    } else {
      this.output = { mode, text: result.output };
      // An output tab already open for this mode follows the preview
      this.outputs.set(OutputDocuments.uri(this.id, this.doc.fileName, mode), result.output);
      url = await this.server.publish(this.id, {
        html: previewPage(mode, result.output, this.server.pagedJsPath),
        assets: result.assets,
        docDir,
        root: this.root,
      });
    }
    this.post({
      type: "show",
      url: url.toString(true),
      v: seq,
      mode,
      dirty: mode === "chunk" && this.doc.isDirty,
      elapsed: Date.now() - started,
    });
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function isInside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The codicon "go-to-file", inline: the panel loads no icon font. */
const GO_TO_FILE = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.58594 1.00098C8.98394 1.00098 9.36646 1.15943 9.64746 1.44043L12.5605 4.35352C12.8415 4.63552 13.001 5.01704 13.001 5.41504V13.001C13.001 14.106 12.106 15.001 11.001 15.001H5.00098C3.89599 15.001 3.00098 14.106 3.00098 13.001V6.00098H4.00098V13.001C4.00098 13.553 4.44899 14.001 5.00098 14.001H11.001C11.553 14.001 12.001 13.553 12.001 13.001V6.00098H9.50098C8.67299 6.00096 8.00098 5.32897 8.00098 4.50098V2.00098C7.99198 1.97699 7.98265 1.9527 7.97266 1.92871C7.89674 1.74704 7.78717 1.5812 7.64746 1.44238L7.20605 1.00098H8.58594ZM9 4.5C9 4.776 9.224 5 9.5 5H11.793L9 2.20703V4.5Z"/><path d="M4.5 0C4.63299 0 4.75952 0.0534683 4.85352 0.147461L6.85352 2.14746C6.90042 2.19336 6.93789 2.24775 6.96289 2.30859C6.98789 2.36959 7.00097 2.43498 7.00098 2.50098C7.00098 2.56698 6.98789 2.63236 6.96289 2.69336C6.93789 2.75323 6.90043 2.80956 6.85352 2.85547L4.85352 4.85547C4.75956 4.94917 4.63278 5.00195 4.5 5.00195C4.36722 5.00195 4.24044 4.94917 4.14648 4.85547C4.05248 4.76147 3.99902 4.63398 3.99902 4.50098C3.99903 4.36799 4.05249 4.24146 4.14648 4.14746L5.29297 3.00098H2.5C2.10201 3.00098 1.72045 3.15944 1.43945 3.44043C1.15846 3.72242 1.00001 4.10298 1 4.50098V5.50098C1 5.63398 0.947516 5.76147 0.853516 5.85547C0.759563 5.94817 0.632774 6.00098 0.5 6.00098C0.367225 6.00098 0.240437 5.94917 0.146484 5.85547C0.0534844 5.76147 0 5.63398 0 5.50098V4.50098C6.17892e-06 3.83799 0.263427 3.20239 0.732422 2.7334C1.20142 2.26441 1.83701 2.00098 2.5 2.00098H5.29297L4.14648 0.855469C4.05248 0.761469 3.99902 0.633977 3.99902 0.500977C3.99903 0.367985 4.05249 0.241455 4.14648 0.147461C4.24048 0.0534683 4.36701 0 4.5 0Z"/></svg>`;

/** The codicon "file-pdf", inline. */
const FILE_PDF = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M13.5 7H13V5.414C13 5.016 12.842 4.635 12.561 4.353L9.647 1.439C9.366 1.158 8.984 1 8.586 1H5C3.895 1 3 1.895 3 3V7H2.5C1.673 7 1 7.673 1 8.5V13.5C1 14.327 1.673 15 2.5 15H13.5C14.327 15 15 14.327 15 13.5V8.5C15 7.673 14.327 7 13.5 7ZM9 2.207L11.793 5H9.5C9.224 5 9 4.776 9 4.5V2.207ZM4 3C4 2.448 4.448 2 5 2H8V4.5C8 5.328 8.672 6 9.5 6H12V7H4V3ZM14 13.5C14 13.775 13.775 14 13.5 14H2.5C2.224 14 2 13.775 2 13.5V8.5C2 8.225 2.224 8 2.5 8H13.5C13.775 8 14 8.225 14 8.5V13.5Z"/><path d="M4.5 9H3.5C3.224 9 3 9.224 3 9.5V12.5C3 12.776 3.224 13 3.5 13C3.776 13 4 12.776 4 12.5V12H4.5C5.327 12 6 11.327 6 10.5C6 9.673 5.327 9 4.5 9ZM4.5 11H4V10H4.5C4.776 10 5 10.225 5 10.5C5 10.775 4.776 11 4.5 11Z"/><path d="M8 9H7.5C7.224 9 7 9.224 7 9.5V12.5C7 12.776 7.224 13 7.5 13H8C9.103 13 10 12.103 10 11C10 9.897 9.103 9 8 9ZM8 12V10C8.552 10 9 10.448 9 11C9 11.552 8.552 12 8 12Z"/><path d="M13 9H11.5C11.224 9 11 9.224 11 9.5V12.5C11 12.776 11.224 13 11.5 13C11.776 13 12 12.776 12 12.5V12H12.5C12.776 12 13 11.776 13 11.5C13 11.224 12.776 11 12.5 11H12V10H13C13.276 10 13.5 9.776 13.5 9.5C13.5 9.224 13.276 9 13 9Z"/></svg>`;

/**
 * The panel around the preview frame. With `collection` (the folder's name)
 * it shows a chunk run of the whole folder: no mode menu, but a Rebuild button.
 */
export function previewHtml(origin: string, mode: PreviewMode, modes: readonly PreviewMode[], collection?: string): string {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    `default-src 'none'`,
    `frame-src ${origin}`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const options = modes.map(
    (m) => `<option value="${m}"${m === mode ? " selected" : ""}>${m}</option>`
  ).join("");
  const controls = collection === undefined
    ? `<label>Output <select id="mode">${options}</select></label>
  <button id="open" title="Open output in editor" aria-label="Open output in editor" disabled>${GO_TO_FILE}</button>
  <button id="export" class="icon" title="Export PDF" aria-label="Export PDF"${mode === "typst" ? "" : " hidden"}>${FILE_PDF}</button>`
    : `<span class="name" title="Every XML file directly in this folder, chunked as opm chunk does">${escapeHtml(collection)}</span>
  <button id="rebuild" title="Chunk the collection again, with the saved files">Rebuild</button>`;
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
  #open, .icon { display: inline-flex; align-items: center; padding: 3px 4px; }
  #open svg, .icon svg { flex: none; }
  button:disabled { opacity: .5; cursor: default; }
  .status { margin-left: auto; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status.busy::before { content: "⟳ "; }
  .name { font-weight: 600; white-space: nowrap; }
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
  ${controls}
  <span class="status" id="status">Starting opm…</span>
</div>
<main>
  <iframe id="frame" title="opm output"></iframe>
  <div class="error" id="error" hidden>
    <p><strong>opm could not ${collection === undefined ? "transform this document" : "chunk this collection"}.</strong> The preview shows the last good output once it can.</p>
    <pre id="message"></pre>
    <p><a id="log">Show the opm log</a> · <a id="restart">Restart opm</a></p>
  </div>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const frame = $("frame"), status = $("status");
  let stale = false;
  let elapsed = 0, hasOutput = false, mode = ${JSON.stringify(mode)};
  /** Page of the chunk site on show, to reload in place on refresh. */
  let chunkPath = null;
  const UNSAVED = "Unsaved changes · chunk reads the saved file: save to update";
  const on = (id, f) => { if ($(id)) $(id).onclick = f; };

  on("open", () => vscode.postMessage({ type: "openOutput" }));
  on("export", () => vscode.postMessage({ type: "exportPdf" }));
  on("rebuild", () => vscode.postMessage({ type: "rebuild" }));
  if ($("mode")) $("mode").onchange = (e) => {
    chunkPath = null;
    $("export").hidden = e.target.value !== "typst";
    vscode.postMessage({ type: "mode", mode: e.target.value });
  };
  const took = (ms) => ms < 2000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s";
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
        if (mode === "chunk" && m.path) chunkPath = m.path;
        if (mode === "chunk" && stale) return;
        setStatus("Up to date · " + took(elapsed) + (m.pages ? " · " + m.pages + " pages" : ""));
      } else {
        setStatus(m.message || "Preview error");
      }
      return;
    }
    switch (m.type) {
      case "busy":
        setStatus(m.label || (hasOutput ? "Updating…" : "Transforming…"), true);
        if ($("rebuild")) $("rebuild").disabled = true;
        break;
      case "show": {
        hasOutput = true;
        elapsed = m.elapsed;
        if ($("rebuild")) $("rebuild").disabled = false;
        mode = m.mode;
        stale = !!m.dirty;
        $("error").hidden = true;
        // A chunk run is a folder of pages: nothing to open as one file
        if ($("open")) {
          $("open").hidden = mode === "chunk";
          $("open").disabled = false;
        }
        const url = new URL(m.url);
        // Stay on the chunk page being read, if it is still there
        if (mode === "chunk" && chunkPath) url.pathname = chunkPath;
        url.searchParams.set("v", m.v);
        frame.src = url.toString();
        if (stale) setStatus(m.message || UNSAVED);
        else setStatus(mode === "print" ? "Paginating…" : "Up to date · " + took(elapsed), mode === "print");
        break;
      }
      case "stale":
        stale = m.dirty;
        if (stale) setStatus(m.message || UNSAVED);
        break;
      case "error":
        if ($("rebuild")) $("rebuild").disabled = false;
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
