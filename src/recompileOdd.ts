import * as path from "path";
import * as vscode from "vscode";
import {
  appCredentialsFromConfig,
  findExistDbConfig,
  isRecompileEligible,
  oddRelativePath,
  recompileContextFor,
  saveAppCredentials,
  type ExistDbAppCredentials,
  type ExistDbConfig,
} from "./existConfig";

const CAN_RECOMPILE_CONTEXT = "oddity.canRecompileOdd";

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
      "oddity.recompileOdd",
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

  const appAuth = await resolveAppAuth(ctx.projectRoot, ctx.config);
  if (!appAuth) {
    return;
  }

  const url = new URL("api/odd", ctx.appBase.endsWith("/") ? ctx.appBase : ctx.appBase + "/");
  url.searchParams.append("odd", ctx.oddPath);

  const auth = Buffer.from(`${appAuth.user}:${appAuth.password}`).toString(
    "base64"
  );

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
        // Node's fetch only says "fetch failed"; the cause names the problem (ECONNREFUSED, …)
        const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
        const msg = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
        vscode.window.showErrorMessage(
          `Could not reach eXist-db at ${ctx.appBase}. Is the server running? (${msg})`
        );
        return;
      }

      const body = await response.text();

      if (response.status === 401) {
        vscode.window.showErrorMessage(
          "Recompile denied: check app user/password in .existdb.json (tei group membership required)."
        );
        return;
      }

      // Without the app, eXist hands the POST to its REST interface, which tries to read the
      // empty body as XML and answers 400 "SAX exception while parsing request"
      const noApp =
        response.status === 404 ||
        (response.status === 400 && /SAX exception while parsing request/i.test(body));
      if (noApp) {
        vscode.window.showErrorMessage(
          `No TEI Publisher app answers at ${ctx.appBase}. Check that the app is installed in eXist-db and that "root" in .existdb.json points to it.`
        );
        return;
      }

      if (!response.ok) {
        const detail = stripHtml(body).slice(0, 200);
        vscode.window.showErrorMessage(
          `Recompile failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
        );
        return;
      }

      showReportToast(ctx.oddPath, body);
    }
  );
}

async function resolveAppAuth(
  projectRoot: string,
  config: ExistDbConfig
): Promise<ExistDbAppCredentials | undefined> {
  const stored = appCredentialsFromConfig(config);
  if (stored) {
    return stored;
  }

  const user = await vscode.window.showInputBox({
    title: "TEI Publisher app credentials",
    prompt: "Username for recompile API (tei group member)",
    ignoreFocusOut: true,
  });
  if (!user) {
    return undefined;
  }

  const password = await vscode.window.showInputBox({
    title: "TEI Publisher app credentials",
    prompt: "Password",
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    return undefined;
  }

  const credentials = { user, password };
  if (!saveAppCredentials(projectRoot, credentials)) {
    vscode.window.showWarningMessage(
      "App credentials were not saved (no .existdb.json found)."
    );
  }
  return credentials;
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
