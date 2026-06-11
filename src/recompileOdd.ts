import * as path from "path";
import * as vscode from "vscode";
import {
  findExistDbConfig,
  isRecompileEligible,
  oddRelativePath,
  recompileContextFor,
} from "./existConfig";

const CAN_RECOMPILE_CONTEXT = "oddTools.canRecompileOdd";

export function registerRecompileOdd(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const updateContext = (uri?: vscode.Uri) => {
    const docPath = uri?.fsPath ?? activeOddPath();
    void vscode.commands.executeCommand(
      "setContext",
      CAN_RECOMPILE_CONTEXT,
      docPath ? isRecompileEligible(docPath) : false
    );
  };

  updateContext();

  return vscode.Disposable.from(
    vscode.commands.registerCommand(
      "oddTools.recompileOdd",
      (uri?: vscode.Uri) => recompileOdd(uri)
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      updateContext(editor?.document.uri)
    ),
    vscode.window.tabGroups.onDidChangeTabs(() => updateContext())
  );
}

function activeOddPath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.fsPath.endsWith(".odd")) {
    return editor.document.uri.fsPath;
  }

  const uri = uriFromTabInput(
    vscode.window.tabGroups.activeTabGroup.activeTab?.input
  );
  return uri?.fsPath.endsWith(".odd") ? uri.fsPath : undefined;
}

function uriFromTabInput(input: unknown): vscode.Uri | undefined {
  if (
    input &&
    typeof input === "object" &&
    "uri" in input &&
    input.uri instanceof vscode.Uri
  ) {
    return input.uri;
  }
  return undefined;
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

      showReportToast(ctx.oddPath, body);
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

function showReportToast(oddPath: string, html: string): void {
  const { ok, errors } = summarizeRecompileReport(html);

  if (errors.length > 0) {
    const more =
      errors.length > 1 ? ` (+${errors.length - 1} more error${errors.length > 2 ? "s" : ""})` : "";
    vscode.window.showErrorMessage(
      `Recompile ${oddPath}: ${errors[0]}${more}`
    );
    return;
  }

  if (ok.length > 0) {
    vscode.window.showInformationMessage(
      `Recompiled ${oddPath}: ${ok.join(", ")}`
    );
    return;
  }

  const text = stripHtml(html);
  vscode.window.showInformationMessage(
    text
      ? `Recompiled ${oddPath}: ${text.slice(0, 200)}`
      : `Recompiled ${oddPath}`
  );
}

/** Parse TEI Publisher's HTML recompile report into per-file outcomes. */
function summarizeRecompileReport(html: string): {
  ok: string[];
  errors: string[];
} {
  const ok: string[] = [];
  const errors: string[] = [];

  for (const match of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = stripHtml(match[1]);
    if (!text) {
      continue;
    }
    if (/\bOK\b/.test(text) && !/\bERROR\b/i.test(text)) {
      ok.push(text.replace(/:\s*OK.*$/i, "").trim());
    } else {
      errors.push(text.slice(0, 200));
    }
  }

  return { ok, errors };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
