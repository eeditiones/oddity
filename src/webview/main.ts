import "@vscode/codicons/dist/codicon.css";
import "./style.css";
import "./odd-editor";

// The default (Electron) context menu only offers text copy/cut/paste, which is
// meaningless over the form's cards and layout. Suppress it there, but keep it
// where it helps — inside text inputs and the CodeMirror editors. composedPath()
// is used so contenteditable nodes inside cm-field's shadow DOM are seen.
window.addEventListener("contextmenu", (e) => {
  const overEditable = e.composedPath().some((node) => {
    const el = node as HTMLElement;
    if (!el.tagName) {
      return false;
    }
    const tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  });
  if (!overEditable) {
    e.preventDefault();
  }
});
