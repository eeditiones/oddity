import { LitElement, html, nothing, TemplateResult } from "lit";
import { ElementSpec, ModelType, MODES } from "../oddTypes";
import { ModelCard, emptyModel } from "./model-card";
import { ModelOpenState } from "./model-open-state";
import { onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd } from "./dnd";
import {
  copyElementSpec,
  pasteModel,
  hasModelClip,
  onClipChange,
} from "./clipboard";
import "./model-card";

void ModelCard;

/**
 * The main panel: one selected elementSpec — its ident and mode, a toolbar, and
 * the list of top-level model cards. Owns the spec's top-level `models` array
 * for add / move / remove / duplicate; persistence flows up via `odd-change`.
 */
export class ElementSpecPanel extends LitElement {
  static properties = {
    spec: { attribute: false },
    specIndex: { type: Number },
    modelOpenState: { attribute: false },
    onDelete: { attribute: false },
  };
  declare spec: ElementSpec;
  declare specIndex: number;
  declare modelOpenState: ModelOpenState;
  declare onDelete?: () => void;

  private unsubClip?: () => void;

  createRenderRoot() {
    return this;
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

  render(): TemplateResult {
    const spec = this.spec;
    if (!spec) {
      return html`<div class="empty-main">Select an element on the left.</div>`;
    }
    const addModel = (type: ModelType) => {
      spec.models.unshift(emptyModel(type));
      this.changed();
    };
    return html`
      <div class="spec-head">
        <input
          class="ident"
          type="text"
          .value=${spec.ident}
          @input=${(e: Event) => {
            spec.ident = (e.target as HTMLInputElement).value;
            this.dispatchEvent(
              new CustomEvent("spec-ident-change", { bubbles: true, composed: true })
            );
            this.changed();
          }}
        />
        <label class="mode">
          MODE:
          <select
            @change=${(e: Event) => {
              spec.mode = (e.target as HTMLSelectElement).value || undefined;
              this.changed();
            }}
          >
            <option value="" ?selected=${!spec.mode}>(none)</option>
            ${MODES.map(
              (m) => html`<option value=${m} ?selected=${spec.mode === m}>${m}</option>`
            )}
          </select>
        </label>
        <span class="spacer"></span>
        <button title="Add model" @click=${() => addModel("model")}>+ model</button>
        <button title="Add modelSequence" @click=${() => addModel("modelSequence")}>+ sequence</button>
        <button title="Add modelGrp" @click=${() => addModel("modelGrp")}>+ group</button>
        <button
          class="icon"
          title="Copy elementSpec"
          @click=${() => copyElementSpec(spec)}
        >
          <span class="codicon codicon-copy"></span>
        </button>
        ${hasModelClip()
          ? html`<button
              class="icon"
              title="Paste model"
              @click=${() => {
                const c = pasteModel();
                if (c) {
                  spec.models.unshift(c);
                  this.changed();
                }
              }}
            ><span class="codicon codicon-clippy"></span></button>`
          : nothing}
        <button class="icon danger" title="Delete element" @click=${() => this.onDelete?.()}>
          <span class="codicon codicon-trash"></span>
        </button>
      </div>

      ${spec.hasUnmodeled
        ? html`<div class="warn">
            This element contains markup the form doesn't edit (e.g. attList /
            content). Saving changes here regenerates only its models; unmodeled
            children are not preserved.
          </div>`
        : nothing}

      <div class="models">
        ${spec.models.length === 0
          ? html`<div class="empty-models">No models yet — add one above.</div>`
          : spec.models.map(
              (m, i) => html`
                <model-card
                  .model=${m}
                  .index=${i}
                  .count=${spec.models.length}
                  .specIndex=${this.specIndex}
                  .path=${[i]}
                  .modelOpenState=${this.modelOpenState}
                  @dragstart=${(e: DragEvent) => onDragStart(e, spec.models, i)}
                  @dragover=${(e: DragEvent) => onDragOver(e, spec.models, i)}
                  @dragleave=${(e: DragEvent) => onDragLeave(e)}
                  @drop=${(e: DragEvent) => {
                    if (onDrop(e, spec.models)) this.changed();
                  }}
                  @dragend=${() => onDragEnd()}
                  .onRemove=${(idx: number) => {
                    spec.models.splice(idx, 1);
                    this.changed();
                  }}
                  .onPaste=${(idx: number) => {
                    const c = pasteModel();
                    if (c) {
                      spec.models.splice(idx + 1, 0, c);
                      this.changed();
                    }
                  }}
                ></model-card>
              `
            )}
      </div>
    `;
  }
}

customElements.define("elementspec-panel", ElementSpecPanel);
