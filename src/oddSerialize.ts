import { ElementSpec, ModelNode, Param, Rendition, RULE_SCHEMA } from "./oddTypes";
import { formatTemplateBody } from "./templateContent";
import { escapeXmlAttr } from "./xmlUtils";
import { preferSingleQuotedStrings } from "./xpathUtils";

/**
 * Serialize an editor {@link ElementSpec} back to ODD XML — the reverse of the
 * parser in {@link parseOdd}, and a port of the TEI Publisher ODD editor's
 * client-side serializer.
 *
 * Attribute values (predicates, parameter XPath expressions, …) are XML-escaped
 * on output and double-quoted XPath literals are normalized to single quotes;
 * {@link parseOdd} unescapes them on input. Element text (templates, rendition
 * CSS, descriptions) is still taken from raw source slices.
 *
 * `indent` is the leading whitespace for the `<elementSpec>` line; `unit` is one
 * indentation step. No trailing newline is added, so the result can be spliced
 * directly over an existing element's source range.
 */
export function serializeElementSpec(
  indent: string,
  unit: string,
  spec: ElementSpec
): string {
  const mode = serAttr("mode", spec.mode);
  const inner = indent + unit;
  const desc = spec.desc ? `${inner}<desc>${spec.desc}</desc>\n` : "";
  const models = serializeModels(inner, unit, spec.models);
  return `${indent}<elementSpec ident="${escapeXmlAttr(spec.ident)}"${mode}>\n${desc}${models}${indent}</elementSpec>`;
}

/** A run of sibling rules, each on its own line and each ending in a newline. */
export function serializeModels(
  indent: string,
  unit: string,
  models: ModelNode[]
): string {
  return models.map((m) => serializeModel(indent, unit, m)).join("");
}

/** One rule and its subtree. Empty when the rule carries no behaviour. */
export function serializeModel(indent: string, unit: string, model: ModelNode): string {
  // A bare <model> with no behaviour carries no meaning and is dropped.
  if (model.type === "model" && !model.behaviour) {
    return "";
  }
  const nested = indent + unit;
  // Each kind of rule takes a different set of attributes and children; writing
  // out anything else would produce ODD the schema rejects.
  const allow = RULE_SCHEMA[model.type];

  const attrs = [
    serAttr("output", model.output),
    allow.predicate ? serXPathAttr("predicate", model.predicate) : "",
    allow.behaviour ? serAttr("behaviour", model.behaviour) : "",
    allow.cssClass ? serAttr("cssClass", model.css) : "",
    model.sourcerend ? ` useSourceRendition="true"` : "",
    allow.pbMode ? serAttr("pb:mode", model.mode) : "",
  ].join("");

  const desc = model.desc ? `${nested}<desc>${model.desc}</desc>\n` : "";
  const models = serializeModels(
    nested,
    unit,
    model.models.filter((m) => allow.nested.includes(m.type))
  );
  const params = allow.params
    ? model.params.map((p) => serializeParam(nested, p)).join("")
    : "";
  const template = allow.template
    ? serializeTemplate(nested, model.template, model.output)
    : "";
  const renditions = model.renditions
    .slice(0, allow.renditions)
    .map((r) => serializeRendition(nested, r))
    .join("");

  // Child order the schema requires: desc, then `model`'s own params/template,
  // then outputRendition, and last the nested rules of a group or sequence.
  const innerXml = `${desc}${params}${template}${renditions}${models}`;
  const end = innerXml.length > 0 ? `>\n${innerXml}${indent}</${model.type}` : "/";
  return `${indent}<${model.type}${attrs}${end}>\n`;
}

function serializeParam(indent: string, param: Param): string {
  // A freshly added parameter has no name yet. It must still be written out:
  // the editor re-parses the source after each save and would drop it.
  const name = ` name="${escapeXmlAttr(param.name)}"`;
  const value = serXPathAttr("value", param.value);
  return param.set
    ? `${indent}<pb:set-param xmlns=""${name}${value}/>\n`
    : `${indent}<param${name}${value}/>\n`;
}

function serializeRendition(indent: string, rendition: Rendition): string {
  const scope =
    rendition.scope && rendition.scope !== "null"
      ? serAttr("scope", rendition.scope)
      : "";
  return `${indent}<outputRendition xml:space="preserve"${scope}>\n${indent}${rendition.css}\n${indent}</outputRendition>\n`;
}

function serializeTemplate(
  indent: string,
  template: string | undefined,
  output?: string
): string {
  if (!template) {
    return "";
  }
  const body = formatTemplateBody(template, output);
  return `${indent}<pb:template xml:space="preserve" xmlns="">${body}</pb:template>\n`;
}

function serAttr(name: string, value?: string): string {
  return value ? ` ${name}="${escapeXmlAttr(value)}"` : "";
}

function serXPathAttr(name: string, value?: string): string {
  return value
    ? ` ${name}="${escapeXmlAttr(preferSingleQuotedStrings(value))}"`
    : "";
}
