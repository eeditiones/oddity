import * as vscode from "vscode";

/**
 * Remove the `xml.fileAssociations` entry ODDity up to 0.6 added for Red Hat's
 * XML extension, which pointed `.odd` files at the bundled `teipublisher_odds.xsd`. ODD
 * validation now comes from oddity-language-server. Entries the user wrote
 * themselves are kept.
 */
export async function removeLegacySchemaBinding(): Promise<void> {
  const config = vscode.workspace.getConfiguration("xml");
  const inspect = config.inspect<{ pattern?: string; systemId?: string }[]>("fileAssociations");
  const ours = (a: { pattern?: string; systemId?: string }) =>
    a.pattern === "**/*.odd" &&
    typeof a.systemId === "string" &&
    a.systemId.replace(/\\/g, "/").endsWith("/teipublisher_odds.xsd");
  const targets: [unknown[] | undefined, vscode.ConfigurationTarget][] = [
    [inspect?.globalValue, vscode.ConfigurationTarget.Global],
    [inspect?.workspaceValue, vscode.ConfigurationTarget.Workspace],
  ];
  for (const [value, target] of targets) {
    const list = (value ?? []) as { pattern?: string; systemId?: string }[];
    if (!list.some(ours)) {
      continue;
    }
    const kept = list.filter((a) => !ours(a));
    await config.update("fileAssociations", kept.length ? kept : undefined, target);
  }
}
