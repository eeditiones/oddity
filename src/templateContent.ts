import { isXmlTemplateOutput } from "./oddTypes";

const CDATA_ESCAPE = "]]]]><![CDATA[>";

/** Body of `<pb:template>` on output — raw XML or a CDATA section. */
export function formatTemplateBody(template: string, output?: string): string {
  if (isXmlTemplateOutput(output)) {
    return template;
  }
  return wrapCdata(template);
}

/**
 * Editor value from the inner XML of `<pb:template>`. A CDATA section is
 * unwrapped to its text; any other content is returned verbatim so that
 * `xml:space="preserve"` markup round-trips unchanged.
 */
export function parseTemplateContent(raw: string): string | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) {
    const inner = trimmed
      .slice("<![CDATA[".length, -"]]>".length)
      .split(CDATA_ESCAPE)
      .join("]]>");
    return inner || undefined;
  }
  return raw;
}

function wrapCdata(text: string): string {
  const escaped = text.split("]]>").join(CDATA_ESCAPE);
  return `<![CDATA[${escaped}]]>`;
}
