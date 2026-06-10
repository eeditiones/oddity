import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const MANAGED_PATTERN = "**/*.odd";
const SCHEMA_RELATIVE = "schemas/teipublisher_odds.xsd";
const SCHEMA_FILE = "teipublisher_odds.xsd";

interface FileAssociation {
  pattern: string;
  systemId: string;
}

/**
 * Ensure the bundled ODD schema is bound to `.odd` files.
 *
 * Strategy ("bundle + fallback"): if every ODD already references a resolvable
 * schema through an `<?xml-model href="…"?>` processing instruction, do
 * nothing — that PI binds the same schema. Otherwise add a managed
 * `xml.fileAssociations` entry pointing at the bundled XSD so validation and
 * completion work regardless.
 */
export async function ensureSchemaBinding(
  context: vscode.ExtensionContext
): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration("oddTools")
    .get<boolean>("autoBindSchema", true);

  if (!enabled) {
    await removeManagedAssociation();
    return;
  }

  if (await allOddsCoveredByXmlModel()) {
    return;
  }

  await addManagedAssociation(context.asAbsolutePath(SCHEMA_RELATIVE));
}

/** True when no ODD needs help — every ODD has a resolvable xml-model PI. */
async function allOddsCoveredByXmlModel(): Promise<boolean> {
  const odds = await vscode.workspace.findFiles(
    "**/*.odd",
    "**/node_modules/**"
  );
  if (odds.length === 0) {
    // No ODDs found yet (e.g. a single untitled/loose file). Bind defensively.
    return false;
  }
  for (const uri of odds) {
    if (!(await hasResolvableXmlModel(uri))) {
      return false;
    }
  }
  return true;
}

async function hasResolvableXmlModel(uri: vscode.Uri): Promise<boolean> {
  let text: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    text = Buffer.from(bytes).toString("utf8");
  } catch {
    return false;
  }
  const match = /<\?xml-model\b[^?]*\bhref\s*=\s*["']([^"']+)["']/i.exec(text);
  if (!match) {
    return false;
  }
  const href = match[1];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    // Absolute URL — assume resolvable, lemminx will fetch it.
    return true;
  }
  const resolved = path.resolve(path.dirname(uri.fsPath), href);
  return fs.existsSync(resolved);
}

async function addManagedAssociation(schemaPath: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("xml");
  const target = configurationTarget();
  const current = readAssociations(config);

  const kept = current.filter((a) => !isManaged(a));
  const desired: FileAssociation = {
    pattern: MANAGED_PATTERN,
    systemId: schemaPath,
  };

  const next = [...kept, desired];
  if (associationsEqual(current, next)) {
    return;
  }
  await config.update("fileAssociations", next, target);
}

async function removeManagedAssociation(): Promise<void> {
  const config = vscode.workspace.getConfiguration("xml");
  const current = readAssociations(config);
  const next = current.filter((a) => !isManaged(a));
  if (associationsEqual(current, next)) {
    return;
  }
  await config.update("fileAssociations", next, configurationTarget());
}

/** Our entries: the managed glob pointing at our bundled schema file. */
function isManaged(a: FileAssociation): boolean {
  return (
    a.pattern === MANAGED_PATTERN &&
    typeof a.systemId === "string" &&
    a.systemId.replace(/\\/g, "/").endsWith(`/${SCHEMA_FILE}`)
  );
}

function readAssociations(
  config: vscode.WorkspaceConfiguration
): FileAssociation[] {
  return config.get<FileAssociation[]>("fileAssociations", []) ?? [];
}

function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function associationsEqual(a: FileAssociation[], b: FileAssociation[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every(
    (x, i) => x.pattern === b[i].pattern && x.systemId === b[i].systemId
  );
}
