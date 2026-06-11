import { ElementSpec, ModelNode, Param, Rendition } from "./oddTypes";
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
  const models = spec.models.map((m) => serializeModel(inner, unit, m)).join("");
  return `${indent}<elementSpec ident="${escapeXmlAttr(spec.ident)}"${mode}>\n${desc}${models}${indent}</elementSpec>`;
}

function serializeModel(indent: string, unit: string, model: ModelNode): string {
  // A bare <model> with no behaviour carries no meaning and is dropped.
  if (model.type === "model" && !model.behaviour) {
    return "";
  }
  const nested = indent + unit;

  const attrs = [
    serAttr("output", model.output),
    serXPathAttr("predicate", model.predicate),
    model.type === "model" ? serAttr("behaviour", model.behaviour) : "",
    serAttr("cssClass", model.css),
    model.sourcerend ? ` useSourceRendition="true"` : "",
    serAttr("pb:mode", model.mode),
  ].join("");

  const desc = model.desc ? `${nested}<desc>${model.desc}</desc>\n` : "";
  const models = model.models.map((m) => serializeModel(nested, unit, m)).join("");
  const params = model.params.map((p) => serializeParam(nested, p)).join("");
  const template = serializeTemplate(nested, model.template);
  const renditions = model.renditions
    .map((r) => serializeRendition(nested, r))
    .join("");

  const innerXml = `${desc}${models}${params}${template}${renditions}`;
  const end = innerXml.length > 0 ? `>\n${innerXml}${indent}</${model.type}` : "/";
  return `${indent}<${model.type}${attrs}${end}>\n`;
}

function serializeParam(indent: string, param: Param): string {
  if (!param.name) {
    return "";
  }
  const name = serAttr("name", param.name);
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

function serializeTemplate(indent: string, template?: string): string {
  if (!template) {
    return "";
  }
  return `${indent}<pb:template xml:space="preserve" xmlns="">${template}</pb:template>\n`;
}

function serAttr(name: string, value?: string): string {
  return value ? ` ${name}="${escapeXmlAttr(value)}"` : "";
}

function serXPathAttr(name: string, value?: string): string {
  return value
    ? ` ${name}="${escapeXmlAttr(preferSingleQuotedStrings(value))}"`
    : "";
}
