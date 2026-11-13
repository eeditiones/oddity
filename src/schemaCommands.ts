import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { relativeHref, setToml, unsetToml, xmlModelEdits } from "oddity-language-server/edit";
import { findOpmProject } from "./opm/project";
import { locatePython, offerInstall } from "./opm/locate";
import { opmLog } from "./opm/helper";

/** Runs opm's command line in the interpreter opm is installed in, as the `opm` script does. */
const OPM_MAIN = "import sys; from opm.cli import main; sys.argv[0] = 'opm'; sys.exit(main())";

export function registerSchemaCommands(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand("oddity.compileOddToRng", (uri?: vscode.Uri) => compileOddToRng(context, uri)),
    vscode.commands.registerCommand("oddity.associateSchema", (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      associateSchema(context, uris?.length ? uris : uri ? [uri] : undefined)
    )
  );
}

function activeUri(ext: string): vscode.Uri | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri && uri.fsPath.toLowerCase().endsWith(ext) ? uri : undefined;
}

/** `opm odd compile <odd> --format rng -o <odd dir>/<name>.rng --force`. */
async function compileOddToRng(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const odd = uri ?? activeUri(".odd");
  if (!odd || odd.scheme !== "file") {
    void vscode.window.showWarningMessage("Open or select an ODD file to compile.");
    return;
  }
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === odd.toString());
  if (open?.isDirty) {
    await open.save();
  }
  let python = await locatePython();
  if (!python && (await offerInstall("Compiling an ODD to RELAX NG"))) {
    python = await locatePython();
  }
  if (!python) {
    return;
  }
  const out = odd.fsPath.replace(/\.odd$/i, "") + ".rng";
  const args = ["-c", OPM_MAIN, "odd", "compile", odd.fsPath, "--format", "rng", "-o", out, "--force"];
  const log = opmLog();
  log.appendLine(`opm ${args.slice(2).join(" ")}`);
  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Compiling ${path.basename(odd.fsPath)} to RELAX NG…` },
    () =>
      new Promise<boolean>((resolve) => {
        execFile(
          python!,
          args,
          { cwd: path.dirname(odd.fsPath), maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
          (err, stdout, stderr) => {
            if (stdout) log.append(stdout);
            if (stderr) log.append(stderr);
            if (err) log.appendLine(`opm failed: ${err.message}`);
            resolve(!err);
          }
        );
      })
  );
  if (!ok) {
    const show = "Show Log";
    if ((await vscode.window.showErrorMessage(`Compiling ${path.basename(odd.fsPath)} failed.`, show)) === show) {
      log.show(true);
    }
    return;
  }
  const associate = "Associate Documents…";
  const choice = await vscode.window.showInformationMessage(
    `Wrote ${vscode.workspace.asRelativePath(out)}.`,
    associate
  );
  if (choice === associate) {
    await associateSchema(context, undefined, vscode.Uri.file(out));
  }
}

interface SchemaPick extends vscode.QuickPickItem {
  /** The RNG, or null to remove the association. */
  target: vscode.Uri | null;
}

/** Associate XML documents with a RELAX NG schema of the project: per document, or for the whole project. */
async function associateSchema(
  context: vscode.ExtensionContext,
  uris?: vscode.Uri[],
  preselect?: vscode.Uri
): Promise<void> {
  const docs = (uris ?? [activeUri(".xml")].filter((u): u is vscode.Uri => !!u)).filter(
    (u) => u.scheme === "file" && !u.fsPath.toLowerCase().endsWith(".odd")
  );
  // without documents (e.g. right after compiling an ODD), the project of the schema
  const anchor = docs[0] ?? preselect;
  const opmRoot = anchor ? findOpmProject(anchor) : undefined;
  const root = anchor ? opmRoot ?? vscode.workspace.getWorkspaceFolder(anchor)?.uri.fsPath : undefined;

  const picks: SchemaPick[] = [];
  if (root) {
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, "**/*.rng"),
      "{**/node_modules/**,**/.git/**,**/dist/**}"
    );
    found.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    for (const rng of found) {
      picks.push({ label: path.basename(rng.fsPath), description: path.relative(root, path.dirname(rng.fsPath)) || ".", target: rng });
    }
  }
  const teiAll = vscode.Uri.file(context.asAbsolutePath(path.join("dist", "schema", "tei", "tei_all.rng")));
  picks.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator, target: null },
    { label: "tei_all.rng", description: "TEI P5, all modules (bundled)", target: teiAll },
    { label: "$(close) Remove association", target: null }
  );
  if (preselect) {
    const i = picks.findIndex((p) => p.target?.fsPath === preselect.fsPath);
    if (i > 0) picks.unshift(...picks.splice(i, 1));
  }

  const scopes: (vscode.QuickPickItem & { project: boolean })[] = [];
  if (docs.length) {
    scopes.push({
      label: docs.length === 1 ? "This document" : `These ${docs.length} documents`,
      description: "via <?xml-model?>",
      project: false,
    });
  }
  if (opmRoot) {
    scopes.push({ label: "All documents in this project", description: "via [editor] schema in opm.toml", project: true });
  }
  if (!scopes.length) {
    void vscode.window.showWarningMessage("Open or select an XML document to associate with a schema.");
    return;
  }

  const pick = await vscode.window.showQuickPick(picks, {
    title: "Associate with RELAX NG schema",
    placeHolder: root ? "A schema in this project" : "A schema",
    matchOnDescription: true,
  });
  if (!pick) {
    return;
  }
  const scope = scopes.length === 1 ? scopes[0] : await vscode.window.showQuickPick(scopes, { title: "Use it for" });
  if (!scope) {
    return;
  }

  if (scope.project) {
    const tomlUri = vscode.Uri.file(path.join(opmRoot!, "opm.toml"));
    const doc = await vscode.workspace.openTextDocument(tomlUri);
    const text = doc.getText();
    const next = pick.target
      ? setToml(text, "editor", "schema", relativeHref(vscode.Uri.file(path.join(opmRoot!, "opm.toml")).toString(), pick.target.toString()))
      : unsetToml(text, "editor", "schema");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(tomlUri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), next);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const uri of docs) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const href = pick.target ? relativeHref(uri.toString(), pick.target.toString()) : null;
    for (const e of xmlModelEdits(doc.getText(), href)) {
      edit.replace(uri, new vscode.Range(doc.positionAt(e.from), doc.positionAt(e.to)), e.insert);
    }
  }
  await vscode.workspace.applyEdit(edit);
}

