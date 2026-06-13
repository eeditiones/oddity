import { ElementSpec, ModelNode, isXmlTemplateOutput } from "../oddTypes";

/** Verify a web/print/epub template is well-formed XML. */
export function validateTemplateXml(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }
  const doc = new DOMParser().parseFromString(
    `<r>${content}</r>`,
    "text/xml"
  );
  const err = doc.querySelector("parsererror");
  if (!err) {
    return undefined;
  }
  return formatParserError(err);
}

/** Pull a concise message out of the browser's `<parsererror>` element. */
function formatParserError(err: Element): string {
  const detail =
    err.querySelector("div")?.textContent?.trim() ??
    err.textContent?.replace(/\s+/g, " ").trim() ??
    "";

  // Chrome / WebKit: "error on line 1 at column 55: …"
  const webkit = detail.match(
    /^error on line (\d+) at column (\d+):\s*(.+)$/i
  );
  if (webkit) {
    const [, line, column, message] = webkit;
    return `${message.trim()} (line ${line}, column ${column})`;
  }

  // Firefox: often "XML Parsing Error: …\nLocation: …"
  const firefox = detail.match(
    /^XML Parsing Error:\s*(.+?)(?:\s*Location:|$)/i
  );
  if (firefox) {
    return firefox[1].trim();
  }

  const stripped = detail
    .replace(/^This page contains the following errors:\s*/i, "")
    .replace(/\s*Below is a rendering of the page up to the first error\..*$/i, "")
    .trim();
  if (stripped) {
    return stripped;
  }
  return "Template is not well-formed XML";
}

function walkModels(
  models: ModelNode[],
  onModel: (model: ModelNode) => string | undefined
): string | undefined {
  for (const model of models) {
    if (model.template && isXmlTemplateOutput(model.output)) {
      const err = onModel(model);
      if (err) {
        return err;
      }
    }
    const nested = walkModels(model.models, onModel);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

/** First template XML error anywhere in an elementSpec, if any. */
export function validateElementSpecTemplates(
  spec: ElementSpec
): string | undefined {
  return walkModels(spec.models, (model) =>
    validateTemplateXml(model.template ?? "")
  );
}
