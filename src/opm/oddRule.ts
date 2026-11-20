import * as fs from "fs";
import * as path from "path";
import { parse } from "@xml-tools/parser";
import { buildAst, XMLDocument, XMLElement } from "@xml-tools/ast";
import * as vscode from "vscode";
import { findNthModelPath, parseTeiDebugClass } from "../debugSignature";
import { insertElementSpec } from "../elementSpecInsert";
import { parseOdd } from "../oddModel";
import { revealInGraphicalEditor } from "../openGraphicalEditorAtElementSpec";
import { OpmHelper, TraceReply } from "./helper";
import { previewModeFor } from "./previewPanel";
import { findOpmProject, isPreviewable } from "./project";

/**
 * Which model of the ODD handles an element of an XML file in an opm project,
 * from `opm transform -t json`: hovering a tag name shows it, with links that
 * open the model in the graphical editor.
 */

const COMMAND = "oddity.showOddRule";

/** One way an element was processed: the record of a model that fired. */
interface Rule {
  element: string;
  /** `tei-head16`, or null when no model matched. */
  key: string | null;
  behaviour: string | null;
  suppressed: boolean;
}

interface Trace {
  reply: TraceReply;
  /** Indexes into reply.records, by xpath. */
  byXpath: Map<string, number[]>;
}

type TraceOutcome = { ok: true; trace: Trace } | { ok: false; error: string };

/** Arguments of the command when a hover link runs it. */
interface RuleArgs {
  uri: string;
  offset: number;
  key: string;
  action?: Action;
}

/** open: the model's own ODD; customize: copy an inherited spec into the project ODD first; view: read-only text. */
type Action = "open" | "customize" | "view";

export function registerShowOddRule(
  context: vscode.ExtensionContext,
  helper: OpmHelper
): vscode.Disposable {
  const traces = new TraceCache(helper);
  const asts = new AstCache();
  return vscode.Disposable.from(
    // Internal: run by the hover's links
    vscode.commands.registerCommand(COMMAND, (args: RuleArgs) =>
      runRuleLink(context, traces, asts, args)
    ),
    vscode.languages.registerHoverProvider(
      { language: "xml", scheme: "file" },
      { provideHover: (doc, pos, token) => hover(traces, asts, doc, pos, token) }
    ),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      traces.forget(doc.uri);
      asts.forget(doc.uri);
    })
  );
}

// ---------------------------------------------------------------------------
// The hover's links

/** Run a link of the hover: open, customize or view the rule `args.key`. */
async function runRuleLink(
  context: vscode.ExtensionContext,
  traces: TraceCache,
  asts: AstCache,
  args: RuleArgs
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri));
  const root = findOpmProject(doc.uri);
  const ast = asts.get(doc);
  const element = ast && elementAt(ast, args.offset);
  if (!root || !element) {
    return;
  }
  const outcome = await traces.get(doc, root);
  if (!outcome.ok) {
    vscode.window.showErrorMessage(`opm could not process ${path.basename(doc.fileName)}: ${outcome.error}`);
    return;
  }
  const rule = rulesFor(outcome.trace, xpathOf(element)).find((r) => r.key === args.key);
  if (rule) {
    await goToRule(context, outcome.trace.reply, rule, args.action);
  }
}

async function goToRule(
  context: vscode.ExtensionContext,
  reply: TraceReply,
  rule: Rule,
  action?: Action
): Promise<void> {
  if (!rule.key) {
    vscode.window.showInformationMessage(
      `No model in the ODD matches this <${rule.element}> in the ${reply.channel} output, so opm processes its content without one.`
    );
    return;
  }
  const target = ruleOdd(reply, rule);
  if (!target) {
    vscode.window.showErrorMessage(
      `The ODD defining ${rule.key} (${reply.models[rule.key]?.source ?? "the project ODD"}) was not found.`
    );
    return;
  }

  const inherited = target !== reply.odd;
  const editable = !inherited || isInWorkspace(target);
  if (!action) {
    action = "open";
    if (!editable) {
      const odd = path.basename(reply.odd ?? "");
      const customize = { label: `Customize in ${odd}`, description: "copy the elementSpec with mode=\"change\" and open it", action: "customize" as const };
      const view = { label: `View in ${path.basename(target)}`, description: "read-only: opm's own copy", action: "view" as const };
      const choice = await vscode.window.showQuickPick([customize, view], {
        title: `${ruleLabel(rule)} is inherited from ${path.basename(target)}`,
      });
      if (!choice) {
        return;
      }
      action = choice.action;
    }
  }

  if (action === "customize" && reply.odd) {
    await customize(context, reply.odd, target, rule);
  } else if (action === "view") {
    await viewReadOnly(target, rule);
  } else {
    await openInGraphicalEditor(target, rule);
  }
}

/** Open the model in the graphical editor of `odd`. */
async function openInGraphicalEditor(odd: string, rule: Rule): Promise<void> {
  const uri = vscode.Uri.file(odd);
  const doc = await vscode.workspace.openTextDocument(uri);
  const model = parseOdd(doc.getText());
  const index = model.elementSpecs.findIndex((s) => s.ident === rule.element);
  if (index < 0) {
    vscode.window.showWarningMessage(`No <elementSpec ident="${rule.element}"> in ${path.basename(odd)}.`);
    return;
  }
  const n = modelNumber(rule, model.elementSpecs.map((s) => s.ident));
  const modelPath = n ? findNthModelPath(model.elementSpecs[index].models, n) : undefined;
  await revealInGraphicalEditor(uri, { ident: rule.element, index, modelPath });
}

/**
 * Copy the inherited elementSpec from the ODD opm used into the project ODD
 * (as `mode="change"`), then open it there. The copy keeps the models in
 * order, so the model number still points at the same model.
 */
async function customize(
  context: vscode.ExtensionContext,
  odd: string,
  source: string,
  rule: Rule
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(odd));
  const defined = parseOdd(doc.getText()).elementSpecs.some((s) => s.ident === rule.element);
  if (!defined) {
    const inserted = await insertElementSpec(context, doc, {
      ident: rule.element,
      parent: { label: path.basename(source), text: fs.readFileSync(source, "utf8") },
    });
    if (!inserted) {
      return;
    }
  }
  await openInGraphicalEditor(odd, rule);
}

/** Show the model in a read-only text editor: for ODDs outside the workspace, such as opm's packaged ones. */
async function viewReadOnly(odd: string, rule: Rule): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(odd));
  const text = doc.getText();
  const spec = parseOdd(text).elementSpecs.find((s) => s.ident === rule.element);
  let offset = spec?.range?.start ?? 0;
  const n = spec && modelNumber(rule, [rule.element]);
  if (spec?.range && n) {
    // The nth <model> start tag (not modelGrp / modelSequence) inside the spec
    const re = /<(?:[\w-]+:)?model[\s/>]/g;
    re.lastIndex = spec.range.start;
    for (let i = 0; i < n; i++) {
      const m = re.exec(text);
      if (!m || m.index > spec.range.end) {
        break;
      }
      offset = m.index;
    }
  }
  const position = doc.positionAt(offset);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(position, position),
    viewColumn: vscode.ViewColumn.Beside,
  });
  await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession");
}

// ---------------------------------------------------------------------------
// The hover

async function hover(
  traces: TraceCache,
  asts: AstCache,
  doc: vscode.TextDocument,
  pos: vscode.Position,
  token: vscode.CancellationToken
): Promise<vscode.Hover | undefined> {
  if (!vscode.workspace.getConfiguration("oddity.opm").get<boolean>("ruleHover", true)) {
    return undefined;
  }
  const root = findOpmProject(doc.uri);
  if (!root || !isPreviewable(doc)) {
    return undefined;
  }
  const ast = asts.get(doc);
  const offset = doc.offsetAt(pos);
  const element = ast && elementAt(ast, offset);
  const name = element && tagNameAt(element, offset);
  if (!element || !name) {
    return undefined;
  }
  const outcome = await traces.get(doc, root);
  if (!outcome.ok || token.isCancellationRequested) {
    return undefined;
  }
  const { trace } = outcome;
  const reply = trace.reply;
  const range = new vscode.Range(doc.positionAt(name.startOffset), doc.positionAt(name.endOffset + 1));

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: [COMMAND] };
  md.supportHtml = false;
  md.appendMarkdown(`**ODD rule** · ${reply.channel} output\n\n`);

  const found = processed(trace, element);
  if (!found) {
    md.appendMarkdown(`Not in the ${reply.channel} output.`);
    return new vscode.Hover(md, range);
  }
  if (found.element !== element) {
    md.appendMarkdown(
      `\`<${element.name}>\` does not reach the output: \`<${found.element.name}>\` around it ` +
        `is handled by a model that does not process it further.\n\n---\n\n`
    );
  }
  const anchor = found.element.position.startOffset;
  found.rules.forEach((rule, i) => {
    if (i > 0) {
      md.appendMarkdown("\n\n---\n\n");
    }
    md.appendMarkdown(ruleMarkdown(doc, reply, rule, anchor));
  });
  return new vscode.Hover(md, range);
}

function ruleMarkdown(doc: vscode.TextDocument, reply: TraceReply, rule: Rule, offset: number): string {
  if (!rule.key) {
    return `\`<${rule.element}>\`: no model matches; opm processes its content without one.`;
  }
  const info = reply.models[rule.key];
  const lines = [`\`<${rule.element}>\` → ${esc(ruleLabel(rule))}`];
  if (info?.predicate) {
    lines.push(`predicate \`${info.predicate.replace(/`/g, "'")}\``);
  }
  if (info?.desc) {
    lines.push(`*${esc(info.desc.replace(/\s+/g, " ").trim())}*`);
  }
  const target = ruleOdd(reply, rule);
  const link = (label: string, action: Action) =>
    `[${esc(label)}](command:${COMMAND}?${encodeURIComponent(
      JSON.stringify([{ uri: doc.uri.toString(), offset, key: rule.key!, action } satisfies RuleArgs])
    )})`;
  if (!target) {
    lines.push(`from ${esc(info?.source ?? "the project ODD")} (not found)`);
  } else if (target === reply.odd || isInWorkspace(target)) {
    lines.push(link(`Open in ${path.basename(target)}`, "open"));
  } else {
    lines.push(
      `inherited from ${esc(path.basename(target))} · ` +
        link(`Customize in ${path.basename(reply.odd ?? "")}`, "customize") +
        " · " +
        link("View", "view")
    );
  }
  return lines.join("  \n");
}

// ---------------------------------------------------------------------------
// Traces and rules

/**
 * The latest trace of each document, for its version and output channel.
 * Hovers ask often; a trace is made once per change of either.
 */
class TraceCache {
  private readonly entries = new Map<string, { version: number; channel: string; outcome: Promise<TraceOutcome> }>();

  constructor(private readonly helper: OpmHelper) {}

  get(doc: vscode.TextDocument, root: string): Promise<TraceOutcome> {
    const key = doc.uri.toString();
    const channel = channelFor(doc.uri);
    const cached = this.entries.get(key);
    if (cached && cached.version === doc.version && cached.channel === channel) {
      return cached.outcome;
    }
    const outcome = this.helper
      .trace({ root, file: doc.uri.fsPath, text: doc.getText(), channel })
      .then((reply): TraceOutcome => {
        if (!reply.ok) {
          return { ok: false, error: reply.error };
        }
        const byXpath = new Map<string, number[]>();
        reply.records.forEach(([xpath], i) => {
          const list = byXpath.get(xpath);
          list ? list.push(i) : byXpath.set(xpath, [i]);
        });
        return { ok: true, trace: { reply, byXpath } };
      });
    this.entries.set(key, { version: doc.version, channel, outcome });
    return outcome;
  }

  forget(uri: vscode.Uri): void {
    this.entries.delete(uri.toString());
  }
}

/** The ODD output channel the preview of `uri` shows; chunks are web pages. */
function channelFor(uri: vscode.Uri): string {
  const mode = previewModeFor(uri);
  return mode === "chunk" ? "web" : mode;
}

/** The distinct rules that handled the element at `xpath`, in document order. */
function rulesFor(trace: Trace, xpath: string): Rule[] {
  const rules: Rule[] = [];
  for (const i of trace.byXpath.get(xpath) ?? []) {
    const [, element, key, behaviour, suppressed] = trace.reply.records[i];
    // A template model records the element twice (its behaviour, then the template)
    if (!rules.some((r) => r.key === key && key !== null)) {
      rules.push({ element, key, behaviour, suppressed });
    }
  }
  return rules;
}

/** The element itself, or its nearest ancestor, that has rules in the trace. */
function processed(trace: Trace, element: XMLElement): { element: XMLElement; rules: Rule[] } | undefined {
  for (let el: XMLElement | XMLDocument = element; el.type === "XMLElement"; el = el.parent) {
    const rules = rulesFor(trace, xpathOf(el));
    if (rules.length) {
      return { element: el, rules };
    }
  }
  return undefined;
}

/** The ODD file a rule's model is defined in. */
function ruleOdd(reply: TraceReply, rule: Rule): string | undefined {
  const source = rule.key ? reply.models[rule.key]?.source : undefined;
  return source ? reply.sources[source] : reply.odd ?? undefined;
}

/** The model's number within its elementSpec, from `tei-head16`. */
function modelNumber(rule: Rule, idents: string[]): number | undefined {
  if (!rule.key) {
    return undefined;
  }
  const prefix = `tei-${rule.element}`;
  const rest = rule.key.slice(prefix.length);
  if (rule.key.startsWith(prefix) && /^[1-9]\d*$/.test(rest)) {
    return Number(rest);
  }
  return parseTeiDebugClass(rule.key, idents)?.modelIndex;
}

function ruleLabel(rule: Rule): string {
  const n = modelNumber(rule, [rule.element]);
  const parts = [n ? `model #${n}` : rule.key ?? "no model", rule.behaviour ?? "default"];
  if (rule.suppressed) {
    parts.push("suppressed");
  }
  return parts.join(" · ");
}

function isInWorkspace(file: string): boolean {
  return !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
}

function esc(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The XML at the cursor

/** The parsed XML of each document, for its latest version. */
class AstCache {
  private readonly entries = new Map<string, { version: number; ast: XMLDocument }>();

  get(doc: vscode.TextDocument): XMLDocument | undefined {
    const key = doc.uri.toString();
    const cached = this.entries.get(key);
    if (cached?.version === doc.version) {
      return cached.ast;
    }
    try {
      const { cst, tokenVector } = parse(doc.getText());
      const ast = buildAst(cst as any, tokenVector);
      this.entries.set(key, { version: doc.version, ast });
      return ast;
    } catch {
      return undefined;
    }
  }

  forget(uri: vscode.Uri): void {
    this.entries.delete(uri.toString());
  }
}

/** The innermost element whose markup contains `offset`. */
export function elementAt(ast: XMLDocument, offset: number): XMLElement | undefined {
  const contains = (el: XMLElement) =>
    el.position.startOffset <= offset && offset <= el.position.endOffset;
  let current = ast.rootElement && contains(ast.rootElement) ? ast.rootElement : undefined;
  while (current) {
    const child: XMLElement | undefined = current.subElements.find(contains);
    if (!child) {
      break;
    }
    current = child;
  }
  return current ?? undefined;
}

/** The start or end tag name token of `el` at `offset`, if the offset is on one. */
function tagNameAt(el: XMLElement, offset: number) {
  return [el.syntax.openName, el.syntax.closeName].find(
    (t) => t && t.startOffset <= offset && offset <= t.endOffset + 1
  );
}

const DEFAULT_NS = "::DEFAULT";

function namespaceOf(el: XMLElement): string {
  return (el.ns ? el.namespaces[el.ns] : el.namespaces[DEFAULT_NS]) ?? "";
}

/**
 * The XPath opm's JSON output gives the element: names for elements in the
 * root's namespace (`/TEI/text[1]/body[1]/div[2]`), `*[n]` for others.
 */
export function xpathOf(el: XMLElement): string {
  let root = el;
  while (root.parent.type === "XMLElement") {
    root = root.parent;
  }
  const defaultNs = namespaceOf(root);
  const steps: string[] = [];
  for (let cur: XMLElement = el; ; cur = cur.parent as XMLElement) {
    const ns = namespaceOf(cur);
    const parent = cur.parent;
    if (parent.type !== "XMLElement") {
      steps.push(ns === defaultNs ? String(cur.name) : "*");
      break;
    }
    if (ns === defaultNs) {
      const same = parent.subElements.filter((c) => c.name === cur.name && namespaceOf(c) === ns);
      steps.push(`${cur.name}[${same.indexOf(cur) + 1}]`);
    } else {
      steps.push(`*[${parent.subElements.indexOf(cur) + 1}]`);
    }
  }
  return "/" + steps.reverse().join("/");
}
