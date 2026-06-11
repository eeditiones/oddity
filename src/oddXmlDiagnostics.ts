import * as vscode from "vscode";

/**
 * Well-formedness error codes reported by LemMinX ({@link XMLSyntaxErrorCode}).
 * Schema/DTD validation uses other codes (cvc-*, MSG_*, …) and is ignored here.
 *
 * @see https://github.com/eclipse-lemminx/lemminx/blob/main/org.eclipse.lemminx/src/main/java/org/eclipse/lemminx/extensions/contentmodel/participants/XMLSyntaxErrorCode.java
 */
const WELL_FORMEDNESS_CODES = new Set([
  "AttributeNotUnique",
  "AttributeNSNotUnique",
  "AttributePrefixUnbound",
  "ContentIllegalInProlog",
  "CustomETag",
  "DashDashInComment",
  "DoctypeNotAllowed",
  "ElementPrefixUnbound",
  "ElementUnterminated",
  "EmptyPrefixedAttName",
  "EncodingDeclRequired",
  "EqRequiredInAttribute",
  "EqRequiredInXMLDecl",
  "ETagRequired",
  "ETagUnterminated",
  "IllegalQName",
  "InvalidCommentStart",
  "LessthanInAttValue",
  "MarkupEntityMismatch",
  "MarkupNotRecognizedInContent",
  "NameRequiredInReference",
  "NoMorePseudoAttributes",
  "OpenQuoteExpected",
  "PITargetRequired",
  "PrematureEOF",
  "PseudoAttrNameExpected",
  "QuoteRequiredInXMLDecl",
  "RootElementTypeMustMatchDoctypedecl",
  "SDDeclInvalid",
  "SemicolonRequiredInReference",
  "SpaceRequiredBeforeEncodingInXMLDecl",
  "SpaceRequiredBeforeStandalone",
  "SpaceRequiredInPI",
  "VersionInfoRequired",
  "VersionNotSupported",
  "XMLDeclUnterminated",
]);

function diagnosticCode(d: vscode.Diagnostic): string {
  const code = d.code;
  if (code === undefined || code === null) {
    return "";
  }
  if (typeof code === "object") {
    return String(code.value);
  }
  return String(code);
}

/** True for syntax / well-formedness diagnostics, not schema validation. */
export function isWellFormednessError(d: vscode.Diagnostic): boolean {
  if (d.severity !== vscode.DiagnosticSeverity.Error) {
    return false;
  }
  const source = d.source ?? "";
  if (source === "XML.Syntax") {
    return true;
  }
  if (source && source !== "xml") {
    return false;
  }
  const code = diagnosticCode(d);
  return code.length > 0 && WELL_FORMEDNESS_CODES.has(code);
}

/** Well-formedness errors for a document (schema validation is ignored). */
export function getXmlWellFormednessErrors(uri: vscode.Uri): string[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter(isWellFormednessError)
    .map((d) => d.message);
}

export function formatXmlErrors(errors: string[]): string | undefined {
  if (errors.length === 0) {
    return undefined;
  }
  if (errors.length === 1) {
    return errors[0];
  }
  return `${errors.length} XML errors — ${errors[0]}`;
}
