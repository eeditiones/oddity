import * as vscode from "vscode";
import {
  removeElementTags,
  selectElement,
  splitElement,
  surroundWithElement,
  type ElementEdit,
} from "oddity-language-server/edit";
import { allowedElements, type AllowedElement } from "./xmlLanguageClient";

/**
 * Element editing, as in opm studio: surround with element, select element
 * (again for its parent), split element, remove element tags. The text work is
 * oddity-language-server's; this applies it to every selection.
 */
export function registerXmlElementCommands(): vscode.Disposable {
  return vscode.Disposable.from(
    command("oddity.surroundWithElement", (editor) => surround(editor)),
    command("oddity.selectElement", (editor) =>
      run(editor, (text, from, to) => selectElement(text, from, to))
    ),
    command("oddity.splitElement", (editor) =>
      run(editor, (text, _from, _to, head) => splitElement(text, head))
    ),
    command("oddity.removeElementTags", (editor) =>
      run(editor, (text, from, to) => removeElementTags(text, from, to))
    )
  );
}

/** A command on the active text editor; edits are made after the command returns, not with its own builder. */
function command(id: string, fn: (editor: vscode.TextEditor) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(id, () => {
    const editor = vscode.window.activeTextEditor;
    return editor ? fn(editor) : undefined;
  });
}

type Command = (text: string, from: number, to: number, head: number) => ElementEdit | null;

/**
 * Run a command on each selection and apply all changes in one edit. Each
 * command's selection counts only its own changes, so it is shifted by the
 * changes made for the selections before it.
 */
async function run(editor: vscode.TextEditor, command: Command): Promise<void> {
  const doc = editor.document;
  const text = doc.getText();
  const results = editor.selections
    .map((s) => {
      const from = doc.offsetAt(s.start), to = doc.offsetAt(s.end);
      return { from, to, edit: command(text, from, to, doc.offsetAt(s.active)), original: s };
    })
    .sort((a, b) => a.from - b.from);
  if (results.every((r) => !r.edit)) {
    return;
  }
  const changes = results.flatMap((r) => r.edit?.changes ?? []);
  if (changes.length) {
    const ok = await editor.edit((b) => {
      for (const c of changes) {
        b.replace(new vscode.Range(doc.positionAt(c.from), doc.positionAt(c.to)), c.insert);
      }
    });
    if (!ok) {
      return;
    }
  }
  let shift = 0;
  const selections: vscode.Selection[] = [];
  for (const r of results) {
    if (!r.edit) {
      const from = r.from + shift, to = r.to + shift;
      selections.push(new vscode.Selection(doc.positionAt(from), doc.positionAt(to)));
      continue;
    }
    const { anchor, head } = r.edit.selection;
    selections.push(new vscode.Selection(doc.positionAt(anchor + shift), doc.positionAt(head + shift)));
    shift += r.edit.changes.reduce((n, c) => n + c.insert.length - (c.to - c.from), 0);
  }
  editor.selections = selections;
  editor.revealRange(editor.selection);
}

interface ElementItem extends vscode.QuickPickItem {
  name: string;
}

/** Ask for an element (those the schema allows here, when it is known) and wrap each selection in it. */
async function surround(editor: vscode.TextEditor): Promise<void> {
  const doc = editor.document;
  const allowed = await allowedElements(doc.uri, doc.offsetAt(editor.selection.start));
  const tag = await askElement(allowed);
  if (tag) {
    await run(editor, (_text, from, to) => surroundWithElement(from, to, tag));
  }
}

/**
 * A quick pick for the element: typed freely, with attributes after the name if
 * wanted. With a schema, only allowed elements: names starting with what is
 * typed first, then those containing it.
 */
function askElement(allowed: AllowedElement[] | null): Promise<string | undefined> {
  const sorted = allowed ? [...allowed].sort((a, b) => a.name.localeCompare(b.name)) : null;
  const pick = vscode.window.createQuickPick<ElementItem>();
  pick.title = "Surround with element";
  pick.placeholder = !sorted
    ? "Element name, with attributes if you like"
    : sorted.length
      ? "An element allowed here; type attributes after the name if you like"
      : "The schema allows no element here";
  // our own filtering: what is typed after the name (attributes) must not hide the element
  pick.matchOnDescription = false;
  const typedName = () => pick.value.trim().split(/\s/)[0] ?? "";
  const render = () => {
    if (!sorted) {
      return;
    }
    const typed = typedName().toLowerCase();
    const starts = sorted.filter((a) => a.name.toLowerCase().startsWith(typed));
    const contains = sorted.filter((a) => !a.name.toLowerCase().startsWith(typed) && a.name.toLowerCase().includes(typed));
    pick.items = [...starts, ...contains].map((a) => ({ label: a.name, description: a.detail, name: a.name, alwaysShow: true }));
  };
  render();
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | undefined) => {
      if (!done) {
        done = true;
        resolve(value);
        pick.dispose();
      }
    };
    pick.onDidChangeValue(render);
    pick.onDidAccept(() => {
      const name = typedName();
      const rest = pick.value.trim().slice(name.length);
      if (!sorted) {
        finish(name ? pick.value.trim() : undefined);
        return;
      }
      // with a schema, only an element it allows: the one typed in full, else the one highlighted
      const chosen = sorted.some((a) => a.name === name) ? name : pick.activeItems[0]?.name;
      if (chosen) {
        finish(chosen + rest);
      }
    });
    pick.onDidHide(() => finish(undefined));
    pick.show();
  });
}
