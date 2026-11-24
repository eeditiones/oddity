import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Where an opm project lives. The two folders differ when the opm files are
 * kept in a subfolder, e.g. `opm/opm.toml` beside `data/`.
 */
export interface OpmProject {
  /** Folder of `opm.toml`: opm resolves templates, profiles and CSS from it. */
  config: string;
  /**
   * Folder holding everything that belongs to the project: the documents and
   * the opm files. Saving a file in it updates a preview; the preview serves
   * no file outside it.
   */
  scope: string;
}

/** Subfolder searched for an `opm.toml` when a folder has none of its own. */
const SUBFOLDER = "opm";

/**
 * The opm project a file belongs to, or undefined when it belongs to none.
 *
 * The `oddity.opm.config` setting, when set, names the `opm.toml` for every
 * file of its workspace folder. Otherwise the nearest folder above the file
 * that has an `opm.toml`, or an `opm/opm.toml`, is the project. The search
 * stops at the workspace folder, or at the file system root for a file outside
 * any workspace.
 */
export function findOpmProject(uri: vscode.Uri): OpmProject | undefined {
  if (uri.scheme !== "file") {
    return undefined;
  }
  const workspace = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  const configured = configuredToml(uri, workspace);
  if (configured) {
    return { config: path.dirname(configured), scope: workspace! };
  }
  let dir = path.dirname(uri.fsPath);
  for (;;) {
    if (isFile(path.join(dir, "opm.toml"))) {
      return { config: dir, scope: dir };
    }
    if (isFile(path.join(dir, SUBFOLDER, "opm.toml"))) {
      return { config: path.join(dir, SUBFOLDER), scope: dir };
    }
    const parent = path.dirname(dir);
    if (dir === workspace || parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** The `opm.toml` the setting names for a file in `workspace`, if it exists. */
function configuredToml(uri: vscode.Uri, workspace: string | undefined): string | undefined {
  const setting = vscode.workspace.getConfiguration("oddity.opm", uri).get<string>("config")?.trim();
  if (!setting || !workspace) {
    return undefined;
  }
  let file = path.resolve(workspace, setting);
  if (isDirectory(file)) {
    file = path.join(file, "opm.toml");
  }
  return isFile(file) ? file : undefined;
}

/** True for documents the preview can transform: XML, but not ODDs. */
export function isPreviewable(doc: vscode.TextDocument): boolean {
  const ext = path.extname(doc.fileName).toLowerCase();
  return ext === ".xml" && !!findOpmProject(doc.uri);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}
