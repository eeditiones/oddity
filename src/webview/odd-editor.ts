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
import { ModelOpenState, modelPathKey } from "./model-open-state";
import { validateElementSpecTemplates } from "./templateValidation";
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
    canRecompile: { attribute: false, state: true },
  };
  declare model?: OddModel;
  declare selected: number;
  declare canRecompile: boolean;

  private newIdent = "";
  private pendingSelectIdent?: string;
  private saveTimer?: number;
  private saveGeneration = 0;
  private lastAppliedGeneration = 0;
  /** Host is applying an `updateElementSpec` we sent. */
  private saveInFlight = false;
  /** Model changed again while a save was in flight. */
  private resaveNeeded = false;
  /** True from the first debounced edit until the host applies it. */
  private pendingSave = false;
  /** Host is waiting for pending edits before writing the file to disk. */
  private flushRequested = false;
  private unsubClip?: () => void;
  private readonly modelOpenState = new ModelOpenState();

  constructor() {
    super();
    this.selected = -1;
    this.canRecompile = false;
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
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.unsubClip?.();
  }

  private onMessage = (e: MessageEvent<HostToWebview>) => {
    const data = e.data;
    if (!data) {
      return;
    }
    if (data.type === "selectIdent") {
      this.selectSpec(data.ident, data.index, data.modelPath);
      return;
    }
    if (data.type === "flush") {
      this.flushRequested = true;
      if (this.saveTimer !== undefined) {
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
      }
      if (this.pendingSave) {
        this.save();
      } else if (!this.saveInFlight) {
        this.finishFlushIfReady();
      }
      return;
    }
    if (data.type === "editApplied") {
      if (data.generation < this.lastAppliedGeneration) {
        return;
      }
      this.lastAppliedGeneration = data.generation;
      this.saveInFlight = false;
      if (this.resaveNeeded) {
        this.resaveNeeded = false;
        this.save();
        return;
      }
      this.pendingSave = false;
      this.finishFlushIfReady();
      return;
    }
    if (data.type !== "load") {
      return;
    }
    // In-memory model is ahead of the document while edits are pending.
    if (this.pendingSave || this.saveInFlight || this.resaveNeeded) {
      this.canRecompile = data.canRecompile ?? this.canRecompile;
      return;
    }
    this.model = data.model;
    this.canRecompile = data.canRecompile ?? false;
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

  private selectSpec(
    ident: string | undefined,
    index: number,
    modelPath?: number[]
  ): void {
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
    if (modelPath?.length && this.selected >= 0) {
      for (let i = 1; i <= modelPath.length; i++) {
        this.modelOpenState.setOpen(this.selected, modelPath.slice(0, i), true);
      }
    }
    this.requestUpdate();
    this.scrollSelectedIntoView();
    if (modelPath?.length) {
      this.scrollModelIntoView(modelPath);
    }
  }

  private scrollSelectedIntoView(): void {
    requestAnimationFrame(() => {
      this.querySelector(".spec-item.active")?.scrollIntoView({
        block: "nearest",
      });
    });
  }

  private scrollModelIntoView(modelPath: number[]): void {
    const key = modelPathKey(modelPath);
    void this.updateComplete.then(() => {
      requestAnimationFrame(() => {
        this.querySelector(`[data-model-path="${key}"]`)?.scrollIntoView({
          block: "nearest",
        });
      });
    });
  }

  private onIdentChange = () => {
    // Refresh the left list label without touching selection.
    this.requestUpdate();
  };

  private scheduleSave = () => {
    this.pendingSave = true;
    if (this.saveInFlight) {
      this.resaveNeeded = true;
      return;
    }
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => this.save(), 300);
  };

  private save() {
    this.saveTimer = undefined;
    if (this.saveInFlight) {
      this.resaveNeeded = true;
      return;
    }
    if (this.model?.xmlError) {
      this.pendingSave = false;
      this.finishFlushIfReady();
      return;
    }
    const spec = this.currentSpec();
    if (!spec) {
      this.pendingSave = false;
      this.finishFlushIfReady();
      return;
    }
    const templateError = validateElementSpecTemplates(spec);
    if (templateError) {
      this.blockSave(this.flushRequested);
      return;
    }
    // Keep the in-memory model aligned with what serialization will write.
    normalizeXPathFields(spec);
    this.saveGeneration++;
    this.saveInFlight = true;
    this.resaveNeeded = false;
    vscode.postMessage({
      type: "updateElementSpec",
      index: this.selected,
      spec: stripRange(spec),
      generation: this.saveGeneration,
    });
  }

  private finishFlushIfReady(force = false) {
    if (
      this.flushRequested &&
      (force || (!this.pendingSave && !this.saveInFlight))
    ) {
      this.flushRequested = false;
      vscode.postMessage({ type: "flushDone" });
    }
  }

  /** Block persisting invalid template XML; still honour Cmd-S flush when forced. */
  private blockSave(forceFlush = false) {
    this.requestUpdate();
    this.finishFlushIfReady(forceFlush);
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

  private recompile() {
    vscode.postMessage({ type: "recompileOdd" });
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
      <div class="editor-root">
        ${model.xmlError
          ? html`<div class="xml-error" role="alert">
              <strong>Malformed XML</strong> — ${model.xmlError}
              <div class="xml-error-hint">
                Fix well-formedness in the text editor. Schema validation errors are
                ignored here; saving from this form is disabled until the XML parses.
              </div>
            </div>`
          : nothing}
        <div class="layout">
        <aside class="sidebar">
          <div class="meta">
            <div class="odd-title">${model.meta.title ?? "ODD"}</div>
            ${model.meta.source
              ? html`<div class="odd-source">source: ${model.meta.source}</div>`
              : nothing}
          </div>
          ${this.canRecompile
            ? html`<button
                class="recompile-btn"
                title="Recompile on server (requires sync)"
                @click=${() => this.recompile()}
              >
                <span class="codicon codicon-sync"></span>
                Recompile
              </button>`
            : nothing}
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
          <div class="sidebar-toolbar">
            <button
              title="Go to elementSpec or TEI debug class (Ctrl/Cmd+F)"
              @click=${() => vscode.postMessage({ type: "findElementSpec" })}
            >
              <span class="codicon codicon-search"></span>
              Go to elementSpec
            </button>
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
      </div>
    `;
  }

  private specList(model: OddModel): TemplateResult[] {
    // Display order only — keep model indices so save/delete stay correct.
    return model.elementSpecs
      .map((spec, index) => ({ spec, index }))
      .sort((a, b) =>
        (a.spec.ident || "").localeCompare(b.spec.ident || "", undefined, {
          sensitivity: "base",
        })
      )
      .map(
        ({ spec, index }) => html`
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
