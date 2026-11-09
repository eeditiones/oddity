import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ChunkProgress, OpmHelper } from "./helper";
import { isInside, previewHtml } from "./previewPanel";
import { findOpmProject } from "./project";
import { chunkPage } from "./render";
import { PreviewServer } from "./server";

const STALE = "Files changed · Rebuild to update";

/**
 * "Preview Collection with opm": the pages `opm chunk <folder>` writes for
 * every XML file directly in a folder, with an index page. A run can take a
 * while, so it is built when the panel opens and again on request only; saving
 * a file of the project marks it out of date.
 */
export class CollectionPreview {
  private readonly panel: vscode.WebviewPanel;
  private readonly id = randomBytes(8).toString("hex");
  private readonly subs: vscode.Disposable[] = [];
  private readonly tmpDir = path.join(os.tmpdir(), "oddity-preview", this.id);
  private ready = false;
  private building = false;
  /** A file was saved since the last run started. */
  private changed = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly helper: OpmHelper,
    private readonly server: PreviewServer,
    private readonly folder: string,
    private readonly root: string,
    private readonly onDispose: () => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "oddity.opmPreview",
      `Preview ${path.basename(folder)}/`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "media", "oddity_icon_light.svg"),
      dark: vscode.Uri.joinPath(context.extensionUri, "media", "oddity_icon_dark.svg"),
    };
    void this.server.origin().then((origin) => {
      this.panel.webview.html = previewHtml(origin, "chunk", [], path.basename(folder));
    });

    this.subs.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
        if (msg.type === "ready") {
          this.ready = true;
          void this.build();
        } else if (msg.type === "rebuild") {
          void this.build();
        } else if (msg.type === "restart") {
          void vscode.commands.executeCommand("oddity.opmRestart");
        } else if (msg.type === "log") {
          this.helper.log.show(true);
        }
      }),
      // Any file of the project may change the pages: the documents, the ODD,
      // CSS, templates, opm.toml
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (isInside(saved.uri.fsPath, this.root)) {
          this.changed = true;
          if (!this.building) {
            this.post({ type: "stale", dirty: true, message: STALE });
          }
        }
      })
    );
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  /** The opm process restarted: build again with it. */
  restarted(): void {
    void this.build();
  }

  dispose(): void {
    this.server.remove(this.id);
    fs.rm(this.tmpDir, { recursive: true, force: true }, () => undefined);
    this.subs.forEach((s) => s.dispose());
    this.subs.length = 0;
    this.onDispose();
    this.panel.dispose();
  }

  private async build(): Promise<void> {
    if (!this.ready || this.building) {
      return;
    }
    this.building = true;
    this.changed = false;
    const started = Date.now();
    this.post({ type: "busy", label: "Chunking…" });
    const result = await this.helper.transform(
      { root: this.root, folder: this.folder, mode: "collection", out: path.join(this.tmpDir, "collection") },
      (p) => this.post({ type: "busy", label: progressLabel(p) })
    );
    this.building = false;
    if (!result.ok) {
      if (result.traceback) {
        this.helper.log.appendLine(result.traceback);
      }
      this.post({ type: "error", message: result.error });
      return;
    }
    if (!("dir" in result) || "pages" in result) {
      return;
    }
    const url = await this.server.publish(this.id, {
      dir: result.dir,
      landing: result.landing,
      page: chunkPage,
      docDir: this.folder,
      root: this.root,
    });
    this.post({
      type: "show",
      url: url.toString(true),
      v: started,
      mode: "chunk",
      dirty: this.changed,
      message: STALE,
      elapsed: Date.now() - started,
    });
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }
}

function progressLabel(p: ChunkProgress): string {
  return (
    `Chunking ${p.name} · document ${p.doc} of ${p.docs}` +
    (p.total > 0 ? ` · page ${p.done} of ${p.total}` : "")
  );
}

/**
 * Folders the explorer offers "Preview Collection with opm" on: those with
 * XML files directly in them, inside a folder with an opm.toml.
 */
export async function collectionFolders(): Promise<string[]> {
  const tomls = await vscode.workspace.findFiles("**/opm.toml");
  if (!tomls.length) {
    return [];
  }
  const roots = tomls.map((u) => path.dirname(u.fsPath));
  const folders = new Set<string>();
  for (const xml of await vscode.workspace.findFiles("**/*.xml")) {
    const dir = path.dirname(xml.fsPath);
    if (!folders.has(dir) && roots.some((r) => isInside(dir, r)) && findOpmProject(xml)) {
      folders.add(dir);
    }
  }
  return [...folders];
}
