import { LitElement, html } from "lit";
import { EditorView, keymap, showPanel, Panel } from "@codemirror/view";
import { EditorState, EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { xml } from "@codemirror/lang-xml";
import { css } from "@codemirror/lang-css";
import { xQuery } from "@codemirror/legacy-modes/mode/xquery";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  StreamLanguage,
  syntaxTree,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

/**
 * Syntax colours derived from VS Code theme tokens. Webviews expose these as
 * CSS variables and update them when the user switches themes.
 */
const vscodeHighlightStyle = HighlightStyle.define([
  {
    tag: tags.comment,
    color: "var(--vscode-descriptionForeground)",
    fontStyle: "italic",
  },
  {
    tag: tags.lineComment,
    color: "var(--vscode-descriptionForeground)",
    fontStyle: "italic",
  },
  {
    tag: tags.blockComment,
    color: "var(--vscode-descriptionForeground)",
    fontStyle: "italic",
  },
  { tag: tags.keyword, color: "var(--vscode-symbolIcon-keywordForeground)" },
  { tag: tags.string, color: "var(--vscode-symbolIcon-stringForeground)" },
  { tag: tags.number, color: "var(--vscode-symbolIcon-numberForeground)" },
  { tag: tags.bool, color: "var(--vscode-symbolIcon-numberForeground)" },
  { tag: tags.null, color: "var(--vscode-symbolIcon-numberForeground)" },
  {
    tag: tags.variableName,
    color: "var(--vscode-symbolIcon-variableForeground)",
  },
  {
    tag: tags.definition(tags.variableName),
    color: "var(--vscode-symbolIcon-variableForeground)",
  },
  { tag: tags.typeName, color: "var(--vscode-symbolIcon-classForeground)" },
  { tag: tags.className, color: "var(--vscode-symbolIcon-classForeground)" },
  { tag: tags.namespace, color: "var(--vscode-symbolIcon-classForeground)" },
  {
    tag: tags.function(tags.variableName),
    color: "var(--vscode-symbolIcon-functionForeground)",
  },
  {
    tag: tags.function(tags.propertyName),
    color: "var(--vscode-symbolIcon-functionForeground)",
  },
  {
    tag: tags.propertyName,
    color: "var(--vscode-symbolIcon-variableForeground)",
  },
  {
    tag: tags.attributeName,
    color: "var(--vscode-symbolIcon-variableForeground)",
  },
  { tag: tags.tagName, color: "var(--vscode-symbolIcon-keywordForeground)" },
  { tag: tags.operator, color: "var(--vscode-symbolIcon-operatorForeground)" },
  { tag: tags.punctuation, color: "var(--vscode-editor-foreground)" },
  {
    tag: tags.bracket,
    color: "var(--vscode-editorBracketHighlight-foreground1, var(--vscode-editor-foreground))",
  },
  { tag: tags.meta, color: "var(--vscode-descriptionForeground)" },
  { tag: tags.invalid, color: "var(--vscode-errorForeground)" },
  {
    tag: tags.heading,
    color: "var(--vscode-symbolIcon-keywordForeground)",
    fontWeight: "bold",
  },
  { tag: tags.link, color: "var(--vscode-textLink-foreground)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  {
    tag: tags.special(tags.string),
    color: "var(--vscode-symbolIcon-stringForeground)",
  },
  {
    tag: tags.processingInstruction,
    color: "var(--vscode-symbolIcon-operatorForeground)",
  },
  {
    tag: tags.quote,
    color: "var(--vscode-symbolIcon-stringForeground)",
    fontStyle: "italic",
  },
]);

/** CodeMirror theme that borrows the surrounding VS Code editor colors. */
const vscodeTheme = EditorView.theme({
  "&": {
    color: "var(--vscode-input-foreground)",
    backgroundColor: "var(--vscode-input-background)",
    border: "1px solid var(--vscode-input-border, transparent)",
    borderRadius: "2px",
    fontSize: "calc(var(--vscode-editor-font-size, 13px) - 1px)",
  },
  ".cm-content": {
    fontFamily: "var(--vscode-editor-font-family, monospace)",
    caretColor: "var(--vscode-editorCursor-foreground)",
  },
  "&.cm-focused": { outline: "1px solid var(--vscode-focusBorder)" },
  ".cm-cursor": { borderLeftColor: "var(--vscode-editorCursor-foreground)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--vscode-editor-selectionBackground)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--vscode-editorLineNumber-foreground)",
    border: "none",
  },
  ".cm-input-panel": {
    padding: "4px 6px",
    borderTop: "1px solid var(--vscode-input-border, transparent)",
  },
  ".cm-input-panel input": {
    width: "100%",
    boxSizing: "border-box",
    color: "var(--vscode-input-foreground)",
    backgroundColor: "var(--vscode-input-background)",
    border: "1px solid var(--vscode-input-border, transparent)",
    fontFamily: "var(--vscode-font-family, sans-serif)",
  },
});

/**
 * The element-name prompt for the "enclose with" command is implemented as a
 * CodeMirror panel rather than `window.prompt` (which is blocked in webviews).
 * Toggling the state field shows/hides the input at the bottom of the editor.
 */
const toggleEncloseWith = StateEffect.define<boolean>();

const encloseWithState = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(toggleEncloseWith)) {
        value = e.value;
      }
    }
    return value;
  },
  provide: (f) =>
    showPanel.from(f, (on) => (on ? createEncloseWithPanel : null)),
});

/** Wrap each selection range with `start`/`end`, keeping the text selected. */
function wrapSelection(view: EditorView, start: string, end: string) {
  view.dispatch(
    view.state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: start },
        { from: range.to, insert: end },
      ],
      range: EditorSelection.range(
        range.from + start.length,
        range.to + start.length
      ),
    }))
  );
}

function createEncloseWithPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-input-panel";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Element name (Enter to confirm, Esc to cancel)";
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const tag = input.value.trim();
      view.dispatch({ effects: toggleEncloseWith.of(false) });
      if (tag) {
        wrapSelection(view, `<${tag}>`, `</${tag}>`);
      }
      view.focus();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      view.dispatch({ effects: toggleEncloseWith.of(false) });
      view.focus();
    }
  });
  dom.appendChild(input);
  return { top: false, dom, mount: () => setTimeout(() => input.focus(), 50) };
}

/**
 * A single-value CodeMirror field as a custom element. Set `value` and
 * `language` ("xml" | "css" | "xquery" | "text"); emits a `cm-change` event
 * (detail = string) on every edit. Used for predicate (XPath-ish), template,
 * rendition-CSS and parameter-value (XQuery) fields.
 */
export class CmField extends LitElement {
  static properties = {
    value: {},
    language: {},
  };
  declare value: string;
  declare language: "xml" | "css" | "xquery" | "text";
  private view?: EditorView;
  /** Suppress cm-change while syncing the document from the value property. */
  private syncing = false;

  constructor() {
    super();
    this.value = "";
    this.language = "text";
  }

  render() {
    return html`<div class="cm-host"></div>`;
  }

  firstUpdated() {
    const host = this.renderRoot.querySelector(".cm-host") as HTMLElement;
    const extensions = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      syntaxHighlighting(vscodeHighlightStyle, { fallback: true }),
      bracketMatching(),
      EditorView.lineWrapping,
      encloseWithState,
      vscodeTheme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !this.syncing) {
          this.value = u.state.doc.toString();
          this.dispatchEvent(
            new CustomEvent("cm-change", {
              detail: this.value,
              bubbles: true,
              composed: true,
            })
          );
        }
      }),
    ];
    if (this.language === "xml") {
      extensions.push(xml());
    } else if (this.language === "css") {
      extensions.push(css());
    } else if (this.language === "xquery") {
      extensions.push(StreamLanguage.define(xQuery));
    }
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: this.value ?? "", extensions }),
    });
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("value") && this.view) {
      const current = this.view.state.doc.toString();
      if (current !== (this.value ?? "")) {
        this.syncing = true;
        try {
          this.view.dispatch({
            changes: { from: 0, to: current.length, insert: this.value ?? "" },
          });
        } finally {
          this.syncing = false;
        }
      }
    }
  }

  /** Insert text at the current cursor (used by the template toolbar). */
  insert(text: string) {
    if (!this.view) {
      return;
    }
    const { from, to } = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    this.view.focus();
  }

  /** Find the innermost XML element node enclosing the given position. */
  private enclosingElement(pos: number) {
    const tree = syntaxTree(this.view!.state);
    // Try both sides so a cursor sitting on a tag boundary (e.g. at the very
    // start of the document, before any click into the editor) still resolves.
    for (const side of [1, -1] as const) {
      const node = tree.resolveInner(pos, side);
      for (let cur: typeof node | null = node; cur; cur = cur.parent) {
        if (cur.name === "Element") {
          return cur;
        }
      }
    }
    return null;
  }

  /** Extend each selection to cover the XML element around the cursor. */
  selectElement() {
    const view = this.view;
    if (!view) {
      return;
    }
    view.dispatch(
      view.state.changeByRange((range) => {
        const el = this.enclosingElement(range.from);
        if (el) {
          const sel = EditorSelection.range(el.from, el.to);
          return { selection: sel, range: sel };
        }
        return { range };
      })
    );
    view.focus();
  }

  /** Prompt for an element name and wrap the current selection in it. */
  encloseWith() {
    const view = this.view;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: toggleEncloseWith.of(!view.state.field(encloseWithState)),
    });
  }

  /** Strip the start/end (or self-closing) tags of the enclosing element. */
  removeEnclosing() {
    const view = this.view;
    if (!view) {
      return;
    }
    view.dispatch(
      view.state.changeByRange((range) => {
        const el = this.enclosingElement(range.from);
        const startTag = el?.firstChild;
        const endTag = el?.lastChild;
        if (!el || !startTag || !endTag) {
          return { range };
        }
        if (startTag.name === "SelfClosingTag") {
          return {
            range: EditorSelection.cursor(startTag.from),
            changes: [{ from: startTag.from, to: startTag.to, insert: "" }],
          };
        }
        return {
          range: EditorSelection.range(
            startTag.from,
            endTag.from - (startTag.to - startTag.from)
          ),
          changes: [
            { from: startTag.from, to: startTag.to, insert: "" },
            { from: endTag.from, to: endTag.to, insert: "" },
          ],
        };
      })
    );
    view.focus();
  }
}

customElements.define("cm-field", CmField);
