import { LitElement, html, nothing, TemplateResult } from "lit";
import { ModelNode, ModelType, BEHAVIOURS, OUTPUTS, SCOPES } from "../oddTypes";
import { onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd } from "./dnd";
import { copyModel, pasteModel, hasClip, onClipChange } from "./clipboard";
import "./codemirror";
import type { CmField } from "./codemirror";

const CUSTOM = "__custom__";

/**
 * Editor for one model / modelGrp / modelSequence rule and (recursively) its
 * nested models. Mutates the model object in place and bubbles a composed
 * `odd-change` event so the root can persist the whole elementSpec; structural
 * operations on this card itself (remove / move / duplicate) are delegated to
 * the owning container via callback properties.
 */
export class ModelCard extends LitElement {
  static properties = {
    model: { attribute: false },
    index: { type: Number },
    count: { type: Number },
    onRemove: { attribute: false },
    onPaste: { attribute: false },
    open: { type: Boolean, state: true },
    custom: { type: Boolean, state: true },
  };
  declare model: ModelNode;
  declare index: number;
  declare count: number;
  declare onRemove?: (i: number) => void;
  /** Insert the clipboard model immediately after the given index. */
  declare onPaste?: (i: number) => void;
  declare open: boolean;
  /** True while the behaviour is being edited as a free-text custom value. */
  declare custom: boolean;

  constructor() {
    super();
    this.index = 0;
    this.count = 1;
    this.open = false;
    this.custom = false;
  }

  willUpdate(changed: Map<string, unknown>) {
    // When a different model is bound to this (reused) card, derive custom mode
    // from its behaviour; toggles during editing of the same model persist.
    if (changed.has("model")) {
      const b = this.model?.behaviour;
      this.custom = !!b && !BEHAVIOURS.includes(b);
    }
  }

  private unsubClip?: () => void;

  createRenderRoot() {
    return this; // light DOM, so the shared stylesheet applies
  }

  connectedCallback() {
    super.connectedCallback();
    this.unsubClip = onClipChange(() => this.requestUpdate());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubClip?.();
  }

  private changed() {
    this.requestUpdate();
    this.dispatchEvent(
      new CustomEvent("odd-change", { bubbles: true, composed: true })
    );
  }

  render() {
    const m = this.model;
    return html`
      <div class="model ${this.open ? "open" : ""}">
        <div class="model-head" @click=${() => (this.open = !this.open)}>
          <span
            class="grip codicon codicon-gripper"
            draggable="true"
            title="Drag to reorder"
            @click=${(e: Event) => e.stopPropagation()}
          ></span>
          <span class="twisty">${this.open ? "▾" : "▸"}</span>
          <span class="model-title">
            ${m.type}
            ${m.type === "model" && m.behaviour
              ? html`<em class="beh">[${m.behaviour}]</em>`
              : nothing}
          </span>
          ${m.output ? html`<span class="tag">${m.output}</span>` : nothing}
          ${m.predicate
            ? html`<code class="pred">${m.predicate}</code>`
            : nothing}
          <span class="spacer"></span>
          ${this.toolbar()}
        </div>
        ${this.open ? this.body() : nothing}
      </div>
    `;
  }

  private toolbar(): TemplateResult {
    const stop = (fn: () => void) => (e: Event) => {
      e.stopPropagation();
      fn();
    };
    return html`
      <span class="model-tools" @click=${(e: Event) => e.stopPropagation()}>
        <button class="icon" title="Copy model" @click=${stop(() => copyModel(this.model))}>
          <span class="codicon codicon-copy"></span>
        </button>
        ${hasClip()
          ? html`<button
              class="icon"
              title="Paste model after this one"
              @click=${stop(() => this.onPaste?.(this.index))}
            >
              <span class="codicon codicon-clippy"></span>
            </button>`
          : nothing}
        <button class="icon" title="Delete" @click=${stop(() => this.onRemove?.(this.index))}>
          <span class="codicon codicon-trash"></span>
        </button>
      </span>`;
  }

  private body(): TemplateResult {
    const m = this.model;
    return html`
      <div class="model-body">
        <div class="row">
          ${this.select(
            "Output",
            m.output ?? "",
            ["", ...OUTPUTS],
            (v) => (m.output = v || undefined)
          )}
          ${this.text("Mode (pb:mode)", m.mode ?? "", (v) => (m.mode = v || undefined))}
        </div>

        ${this.text("Description", m.desc ?? "", (v) => (m.desc = v || undefined))}

        <div class="field">
          <span>Predicate</span>
          <cm-field
            language="xquery"
            .value=${m.predicate ?? ""}
            @cm-change=${(e: CustomEvent<string>) => {
              m.predicate = e.detail || undefined;
              this.changed();
            }}
          ></cm-field>
        </div>

        ${m.type === "model" ? this.behaviourField() : nothing}

        ${this.text("CSS Class", m.css ?? "", (v) => (m.css = v || undefined))}

        ${this.templateField()}

        ${this.paramsSection()}
        ${this.renditionsSection()}

        ${m.type !== "model" ? this.nestedModels() : nothing}
      </div>
    `;
  }

  private behaviourField(): TemplateResult {
    const m = this.model;
    const showCustom =
      this.custom || (!!m.behaviour && !BEHAVIOURS.includes(m.behaviour));
    return html`
      <div class="row">
        <label class="field">
          <span>behaviour</span>
          <select
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === CUSTOM) {
                this.custom = true;
                // Start the free-text field empty unless an unknown value is already set.
                m.behaviour =
                  m.behaviour && !BEHAVIOURS.includes(m.behaviour) ? m.behaviour : "";
              } else {
                this.custom = false;
                m.behaviour = v || undefined;
              }
              this.changed();
            }}
          >
            <option value="" ?selected=${!showCustom && !m.behaviour}>(none)</option>
            ${BEHAVIOURS.map(
              (b) =>
                html`<option value=${b} ?selected=${!showCustom && m.behaviour === b}>
                  ${b}
                </option>`
            )}
            <option value=${CUSTOM} ?selected=${showCustom}>custom…</option>
          </select>
        </label>
        ${showCustom
          ? this.text("Custom Behaviour", m.behaviour ?? "", (v) => (m.behaviour = v || undefined))
          : nothing}
      </div>
    `;
  }

  private templateField(): TemplateResult {
    const m = this.model;
    const insert = (text: string) => {
      const cm = this.querySelector(".tmpl cm-field") as CmField | null;
      cm?.insert(text);
    };
    return html`
      <div class="field tmpl">
        <span>
          Template
          <span class="tmpl-tools">
            <button type="button" @click=${() => insert("<>")}>&lt;l&gt;</button>
            <button type="button" @click=${() => insert("<...>")}>&lt;...&gt;</button>
            <button type="button" @click=${() => insert("<x/>")}>&lt;X&gt;</button>
            <button type="button" @click=${() => insert("[[content]]")}>[[…]]</button>
          </span>
        </span>
        <cm-field
          language="xml"
          .value=${m.template ?? ""}
          @cm-change=${(e: CustomEvent<string>) => {
            m.template = e.detail || undefined;
            this.changed();
          }}
        ></cm-field>
      </div>
    `;
  }

  private paramsSection(): TemplateResult {
    const m = this.model;
    return html`
      <div class="section">
        <div class="section-head">
          <strong>Parameters</strong>
          <button
            class="icon"
            title="Add parameter"
            @click=${() => {
              m.params.push({ name: "", value: "", set: false });
              this.changed();
            }}
          ><span class="codicon codicon-add"></span></button>
        </div>
        ${m.params.map(
          (p, i) => html`
            <div class="row param">
              ${this.text("Name", p.name, (v) => (p.name = v), "name")}
              <label class="field value">
                <span>Value</span>
                <cm-field
                  language="xquery"
                  .value=${p.value}
                  @cm-change=${(e: CustomEvent<string>) => {
                    p.value = e.detail;
                    this.changed();
                  }}
                ></cm-field>
              </label>
              <label class="inline">
                <input
                  type="checkbox"
                  ?checked=${p.set}
                  @change=${(e: Event) => {
                    p.set = (e.target as HTMLInputElement).checked;
                    this.changed();
                  }}
                />set
              </label>
              <button
                class="icon"
                title="Remove"
                @click=${() => {
                  m.params.splice(i, 1);
                  this.changed();
                }}
              ><span class="codicon codicon-trash"></span></button>
            </div>
          `
        )}
      </div>
    `;
  }

  private renditionsSection(): TemplateResult {
    const m = this.model;
    return html`
      <div class="section">
        <div class="section-head">
          <strong>Renditions</strong>
          <button
            class="icon"
            title="Add rendition"
            @click=${() => {
              m.renditions.push({ scope: undefined, css: "" });
              this.changed();
            }}
          ><span class="codicon codicon-add"></span></button>
          <label class="inline src-rend">
            <input
              type="checkbox"
              ?checked=${!!m.sourcerend}
              @change=${(e: Event) => {
                m.sourcerend = (e.target as HTMLInputElement).checked;
                this.changed();
              }}
            />Use source rendition
          </label>
        </div>
        ${m.renditions.map(
          (r, i) => html`
            <div class="row rendition">
              ${this.select(
                "Scope",
                r.scope ?? "",
                ["", ...SCOPES],
                (v) => (r.scope = v || undefined),
                "scope"
              )}
              <label class="field grow">
                <span>Rendition CSS</span>
                <cm-field
                  language="css"
                  .value=${r.css}
                  @cm-change=${(e: CustomEvent<string>) => {
                    r.css = e.detail;
                    this.changed();
                  }}
                ></cm-field>
              </label>
              <button
                class="icon"
                title="Remove"
                @click=${() => {
                  m.renditions.splice(i, 1);
                  this.changed();
                }}
              ><span class="codicon codicon-trash"></span></button>
            </div>
          `
        )}
      </div>
    `;
  }

  private nestedModels(): TemplateResult {
    const m = this.model;
    const addModel = (type: ModelType) => {
      m.models.push(emptyModel(type));
      this.open = true;
      this.changed();
    };
    return html`
      <div class="section nested">
        <div class="section-head">
          <strong>Nested models</strong>
          <button title="Add model" @click=${() => addModel("model")}>+ model</button>
          <button title="Add modelSequence" @click=${() => addModel("modelSequence")}>+ sequence</button>
          <button title="Add modelGrp" @click=${() => addModel("modelGrp")}>+ group</button>
          ${hasClip()
            ? html`<button
                class="icon"
                title="Paste model"
                @click=${() => {
                  const c = pasteModel();
                  if (c) {
                    m.models.push(c);
                    this.open = true;
                    this.changed();
                  }
                }}
              ><span class="codicon codicon-clippy"></span></button>`
            : nothing}
        </div>
        ${m.models.map(
          (child, i) => html`
            <model-card
              .model=${child}
              .index=${i}
              .count=${m.models.length}
              @dragstart=${(e: DragEvent) => onDragStart(e, m.models, i)}
              @dragover=${(e: DragEvent) => onDragOver(e, m.models, i)}
              @dragleave=${(e: DragEvent) => onDragLeave(e)}
              @drop=${(e: DragEvent) => {
                if (onDrop(e, m.models)) this.changed();
              }}
              @dragend=${() => onDragEnd()}
              .onRemove=${(idx: number) => {
                m.models.splice(idx, 1);
                this.changed();
              }}
              .onPaste=${(idx: number) => {
                const c = pasteModel();
                if (c) {
                  m.models.splice(idx + 1, 0, c);
                  this.changed();
                }
              }}
            ></model-card>
          `
        )}
      </div>
    `;
  }

  // --- small field helpers -------------------------------------------------

  private text(
    label: string,
    value: string,
    set: (v: string) => void,
    cls = ""
  ): TemplateResult {
    return html`
      <label class="field ${cls}">
        <span>${label}</span>
        <input
          type="text"
          .value=${value}
          @input=${(e: Event) => {
            set((e.target as HTMLInputElement).value);
            this.changed();
          }}
        />
      </label>
    `;
  }

  private select(
    label: string,
    value: string,
    options: string[],
    set: (v: string) => void,
    cls = ""
  ): TemplateResult {
    return html`
      <label class="field ${cls}">
        <span>${label}</span>
        <select
          @change=${(e: Event) => {
            set((e.target as HTMLSelectElement).value);
            this.changed();
          }}
        >
          ${options.map(
            (o) =>
              html`<option value=${o} ?selected=${value === o}>
                ${o || "(default)"}
              </option>`
          )}
        </select>
      </label>
    `;
  }
}

export function emptyModel(type: ModelType): ModelNode {
  return {
    type,
    behaviour: type === "model" ? "inline" : undefined,
    params: [],
    renditions: [],
    models: [],
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

customElements.define("model-card", ModelCard);
