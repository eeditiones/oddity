import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Folder of the nearest `opm.toml` above a file, or undefined when the file is
 * not part of an opm project. The search stops at the workspace folder, or at
 * the file system root for a file outside any workspace.
 */
export function findOpmProject(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== "file") {
    return undefined;
  }
  const stop = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  let dir = path.dirname(uri.fsPath);
  for (;;) {
    if (fs.existsSync(path.join(dir, "opm.toml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (dir === stop || parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** True for documents the preview can transform: XML, but not ODDs. */
export function isPreviewable(doc: vscode.TextDocument): boolean {
  const ext = path.extname(doc.fileName).toLowerCase();
  return ext === ".xml" && !!findOpmProject(doc.uri);
}
