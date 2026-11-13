import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

/** The schema the server chose for a document (oddity-language-server's SchemaChoice). */
interface SchemaChoice {
  url: string;
  via: "xml-model" | "project" | "default";
}

let client: LanguageClient | undefined;

/**
 * Start oddity-language-server for every XML document (ODDs included, as
 * ODDity maps `.odd` to `xml`): validation and completion against the
 * document's RELAX NG schema, outline, and start/end tag renaming.
 */
export function startXmlLanguageClient(context: vscode.ExtensionContext): vscode.Disposable {
  const module = context.asAbsolutePath(path.join("dist", "server.js"));
  const schemas = vscode.Uri.file(context.asAbsolutePath(path.join("dist", "schema")));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6019"] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "xml", scheme: "file" }],
    synchronize: {
      // only to tell the server when a schema or project settings change on disk
      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/*.rng"),
        vscode.workspace.createFileSystemWatcher("**/opm.toml"),
      ],
    },
    initializationOptions: {
      defaultSchemas: {
        odd: vscode.Uri.joinPath(schemas, "odd", "teipublisher_odds.rng").toString(),
        tei: vscode.Uri.joinPath(schemas, "tei", "tei_all.rng").toString(),
      },
    },
  };
  client = new LanguageClient("oddity.xml", "ODDity XML", serverOptions, clientOptions);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "oddity.associateSchema";
  const schemas_ = new Map<string, SchemaChoice | null>();
  const showStatus = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== "xml" || !schemas_.has(doc.uri.toString())) {
      status.hide();
      return;
    }
    const choice = schemas_.get(doc.uri.toString());
    if (!choice) {
      status.text = "$(file-code) No schema";
      status.tooltip = "Well-formedness only. Click to associate a RELAX NG schema.";
    } else {
      const name = decodeURIComponent(choice.url.replace(/.*\//, ""));
      const via = { "xml-model": "the document's xml-model", project: "opm.toml [editor] schema", default: "the default schema" }[choice.via];
      status.text = `$(file-code) ${name}`;
      status.tooltip = `${vscode.Uri.parse(choice.url).fsPath}\nfrom ${via}. Click to change.`;
    }
    status.show();
  };

  client.onNotification("oddity/schemaChanged", ({ uri, schema }: { uri: string; schema: SchemaChoice | null }) => {
    schemas_.set(uri, schema);
    showStatus();
  });
  void client.start();

  return vscode.Disposable.from(
    status,
    vscode.window.onDidChangeActiveTextEditor(showStatus),
    vscode.workspace.onDidCloseTextDocument((d) => schemas_.delete(d.uri.toString())),
    { dispose: () => void stopXmlLanguageClient() }
  );
}

/** An element the schema allows, with its gloss. */
export interface AllowedElement {
  name: string;
  detail?: string;
}

/** The elements the document's schema allows at offset, or null when it has no schema (or the server is not running). */
export async function allowedElements(uri: vscode.Uri, offset: number): Promise<AllowedElement[] | null> {
  if (!client?.isRunning()) {
    return null;
  }
  try {
    return await client.sendRequest<AllowedElement[] | null>("oddity/allowedElements", { uri: uri.toString(), offset });
  } catch {
    return null;
  }
}

export function stopXmlLanguageClient(): Thenable<void> | undefined {
  const c = client;
  client = undefined;
  return c?.stop();
}
