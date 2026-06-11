import { LitElement, html } from "lit";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { xml } from "@codemirror/lang-xml";
import { css } from "@codemirror/lang-css";
import { xQuery } from "@codemirror/legacy-modes/mode/xquery";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  StreamLanguage,
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
});

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
}

customElements.define("cm-field", CmField);
