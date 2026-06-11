import "@vscode/codicons/dist/codicon.css";
import "./style.css";
import "./odd-editor";
import { vscode } from "./vscodeApi";

function isEditableTarget(e: Event): boolean {
  return e.composedPath().some((node) => {
    const el = node as HTMLElement;
    if (!el.tagName) {
      return false;
    }
    const tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  });
}

// Cmd/Ctrl+F on the form opens the elementSpec picker; in CodeMirror/inputs the
// shortcut is left to VS Code / the embedded editor.
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f" || e.shiftKey) {
    return;
  }
  if (isEditableTarget(e)) {
    return;
  }
  e.preventDefault();
  vscode.postMessage({ type: "findElementSpec" });
});

// The default (Electron) context menu only offers text copy/cut/paste, which is
// meaningless over the form's cards and layout. Suppress it there, but keep it
// where it helps — inside text inputs and the CodeMirror editors. composedPath()
// is used so contenteditable nodes inside cm-field's shadow DOM are seen.
window.addEventListener("contextmenu", (e) => {
  if (!isEditableTarget(e)) {
    e.preventDefault();
  }
});
