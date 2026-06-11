import { LitElement, html, nothing, TemplateResult } from "lit";
import { OddModel, HostToWebview, ElementSpec } from "../oddTypes";
import { normalizeXPathFields } from "../xpathUtils";
import { vscode } from "./vscodeApi";
import {
  hasElementSpecClip,
  onClipChange,
  pasteElementSpec,
} from "./clipboard";
import { ElementSpecPanel } from "./elementspec-panel";
import { ModelOpenState } from "./model-open-state";
import "./elementspec-panel";

void ElementSpecPanel;

/**
 * Root of the graphical ODD editor webview. Holds the model received from the
 * host, drives the left element list + selection, and translates edits into
 * messages: in-place field edits debounce into `updateElementSpec`; structural
 * changes post `addElementSpec` / `deleteElementSpec` / `updateMeta` and let the
 * host push a fresh model back.
 */
export class OddEditor extends LitElement {
  static properties = {
    model: { attribute: false, state: true },
    selected: { attribute: false, state: true },
  };
  declare model?: OddModel;
  declare selected: number;

  private newIdent = "";
  private pendingSelectIdent?: string;
  private saveTimer?: number;
  private unsubClip?: () => void;
  private readonly modelOpenState = new ModelOpenState();

  constructor() {
    super();
    this.selected = -1;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.modelOpenState.onChange = () => this.requestUpdate();
    window.addEventListener("message", this.onMessage);
    this.addEventListener("odd-change", this.scheduleSave as EventListener);
    this.addEventListener("spec-ident-change", this.onIdentChange as EventListener);
    this.unsubClip = onClipChange(() => this.requestUpdate());
    vscode.postMessage({ type: "ready" });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("message", this.onMessage);
    this.unsubClip?.();
  }

  private onMessage = (e: MessageEvent<HostToWebview>) => {
    const data = e.data;
    if (!data) {
      return;
    }
    if (data.type === "selectIdent") {
      this.selectSpec(data.ident, data.index);
      return;
    }
    if (data.type !== "load") {
      return;
    }
    this.model = data.model;
    const specs = this.model.elementSpecs;
    const selectIdent = data.selectIdent ?? this.pendingSelectIdent;
    if (selectIdent) {
      const i = specs.findIndex((s) => s.ident === selectIdent);
      this.selected = i >= 0 ? i : Math.min(this.selected, specs.length - 1);
      this.pendingSelectIdent = undefined;
    } else if (this.selected < 0 || this.selected >= specs.length) {
      this.selected = specs.length ? 0 : -1;
    }
    this.requestUpdate();
    this.scrollSelectedIntoView();
  };

  private selectSpec(ident: string | undefined, index: number): void {
    const specs = this.model?.elementSpecs;
    if (!specs?.length) {
      return;
    }
    if (ident) {
      const i = specs.findIndex((s) => s.ident === ident);
      if (i >= 0) {
        this.selected = i;
      }
    } else if (index >= 0 && index < specs.length) {
      this.selected = index;
    }
    this.requestUpdate();
    this.scrollSelectedIntoView();
  }

  private scrollSelectedIntoView(): void {
    requestAnimationFrame(() => {
      this.querySelector(".spec-item.active")?.scrollIntoView({
        block: "nearest",
      });
    });
  }

  private onIdentChange = () => {
    // Refresh the left list label without touching selection.
    this.requestUpdate();
  };

  private scheduleSave = () => {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => this.save(), 300);
  };

  private save() {
    const spec = this.currentSpec();
    if (!spec) {
      return;
    }
    // Keep the in-memory model aligned with what serialization will write.
    normalizeXPathFields(spec);
    this.requestUpdate();
    vscode.postMessage({
      type: "updateElementSpec",
      index: this.selected,
      spec: stripRange(spec),
    });
  }

  private currentSpec(): ElementSpec | undefined {
    return this.model?.elementSpecs[this.selected];
  }

  private addSpec() {
    const ident = this.newIdent.trim();
    if (ident) {
      this.pendingSelectIdent = ident;
    }
    this.newIdent = "";
    vscode.postMessage({
      type: "addElementSpec",
      ident: ident || undefined,
    });
  }

  private deleteSpec() {
    if (this.selected < 0) {
      return;
    }
    this.modelOpenState.removeSpec(this.selected);
    vscode.postMessage({ type: "deleteElementSpec", index: this.selected });
  }

  render(): TemplateResult {
    const model = this.model;
    if (!model) {
      return html`<div class="loading">Loading…</div>`;
    }
    if (model.empty) {
      return html`<div class="loading">
        No &lt;schemaSpec&gt; found in this file.
      </div>`;
    }
    return html`
      <div class="layout">
        <aside class="sidebar">
          <div class="meta">
            <div class="odd-title">${model.meta.title ?? "ODD"}</div>
            ${model.meta.source
              ? html`<div class="odd-source">source: ${model.meta.source}</div>`
              : nothing}
          </div>
          <div class="add-element">
            <input
              type="text"
              placeholder="Add element…"
              .value=${this.newIdent}
              @input=${(e: Event) => (this.newIdent = (e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") this.addSpec();
              }}
            />
            <button title="Add element" @click=${() => this.addSpec()}>+</button>
            ${hasElementSpecClip()
              ? html`<button
                  class="icon"
                  title="Paste elementSpec"
                  @click=${() => pasteElementSpec()}
                >
                  <span class="codicon codicon-clippy"></span>
                </button>`
              : nothing}
          </div>
          <div class="spec-list">
            ${this.specList(model)}
          </div>
        </aside>
        <main class="main">
          <elementspec-panel
            .spec=${this.currentSpec()}
            .specIndex=${this.selected}
            .modelOpenState=${this.modelOpenState}
            .onDelete=${() => this.deleteSpec()}
          ></elementspec-panel>
        </main>
      </div>
    `;
  }

  private specList(model: OddModel): TemplateResult[] {
    return model.elementSpecs.map(
        (spec, index) => html`
          <div
            class="spec-item ${index === this.selected ? "active" : ""}"
            @click=${() => {
              this.selected = index;
            }}
          >
            ${spec.ident || "(no ident)"}
            ${spec.mode ? html`<span class="mode-badge">${spec.mode}</span>` : nothing}
          </div>
        `
      );
  }
}

/** Drop the host-only source range before sending a spec back. */
function stripRange(spec: ElementSpec): ElementSpec {
  const { range, ...rest } = spec;
  void range;
  return rest;
}

customElements.define("odd-editor", OddEditor);
