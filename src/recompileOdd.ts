import * as path from "path";
import * as vscode from "vscode";
import {
  findExistDbConfig,
  oddRelativePath,
  recompileContextFor,
} from "./existConfig";

export function registerRecompileOdd(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "oddTools.recompileOdd",
    (uri?: vscode.Uri) => recompileOdd(uri)
  );
}

async function recompileOdd(uri?: vscode.Uri): Promise<void> {
  const doc = await resolveDocument(uri);
  if (!doc) {
    vscode.window.showWarningMessage(
      "Open a .odd file to recompile in TEI Publisher."
    );
    return;
  }

  const ctx = recompileContextFor(doc);
  if (!ctx) {
    const found = findExistDbConfig(path.dirname(doc.uri.fsPath));
    if (!found || !oddRelativePath(found.projectRoot, doc.uri.fsPath)) {
      return;
    }
    vscode.window.showInformationMessage(
      "Recompile requires a valid server entry in .existdb.json."
    );
    return;
  }

  if (doc.isDirty) {
    const saved = await doc.save();
    if (!saved) {
      return;
    }
  }

  const url = new URL("api/odd", ctx.appBase.endsWith("/") ? ctx.appBase : ctx.appBase + "/");
  url.searchParams.append("odd", ctx.oddPath);

  const auth = Buffer.from(
    `${ctx.server.user}:${ctx.server.password}`
  ).toString("base64");

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Recompiling ${ctx.oddPath}`,
      cancellable: false,
    },
    async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}` },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Could not reach TEI Publisher at ${ctx.appBase}: ${msg}`
        );
        return;
      }

      const body = await response.text();

      if (response.status === 401) {
        vscode.window.showErrorMessage(
          "Recompile denied: check user/password in .existdb.json (tei group membership required)."
        );
        return;
      }

      if (!response.ok) {
        vscode.window.showErrorMessage(
          `Recompile failed (${response.status}): ${body.slice(0, 200)}`
        );
        return;
      }

      showReport(ctx.oddPath, body);
    }
  );
}

async function resolveDocument(
  uri?: vscode.Uri
): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    return vscode.workspace.openTextDocument(uri);
  }
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.fileName.endsWith(".odd")) {
    return editor.document;
  }
  return undefined;
}

function showReport(oddPath: string, html: string): void {
  const panel = vscode.window.createWebviewPanel(
    "oddRecompileReport",
    `ODD recompile: ${oddPath}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  panel.webview.html = wrapReport(html);
}

function wrapReport(body: string): string {
  const trimmed = body.trim();
  if (/^<!DOCTYPE/i.test(trimmed) || /^<html/i.test(trimmed)) {
    return trimmed;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ODD recompile report</title>
</head>
<body>
${body}
</body>
</html>`;
}
