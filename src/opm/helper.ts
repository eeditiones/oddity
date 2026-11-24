import { ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";
import { checkOpmVersion, locatePython, offerInstall } from "./locate";

export type TransformRequest =
  | { root: string; file: string; mode: string; text: string }
  /** Chunk the saved file into the folder `out`. */
  | { root: string; file: string; mode: "chunk"; out: string }
  /** Chunk every XML file directly in the folder `folder` into the folder `out`. */
  | { root: string; folder: string; mode: "collection"; out: string }
  /** Compile the Typst output with `typst` to SVG pages in `out`, or to the PDF file `pdf`. */
  | { root: string; file: string; mode: "typst"; text: string; typst: string; out?: string; pdf?: string };

export type TransformResult =
  | { ok: true; output: string; assets: Record<string, string> }
  /** A chunk run: the pages are in `dir`; `landing` is the one to open first. */
  | { ok: true; dir: string; landing: string }
  /** Typst pages: the source in `output`, one SVG per page in `dir`. */
  | { ok: true; output: string; dir: string; pages: string[] }
  /** A PDF export. */
  | { ok: true; pdf: string }
  | { ok: false; error: string; traceback?: string };

/** How far a collection run has got: document `doc` of `docs`, page `done` of `total` (0 while unknown). */
export interface ChunkProgress {
  doc: number;
  docs: number;
  name: string;
  done: number;
  total: number;
}

/** Which ODD model handled each element (media/opm_preview.py, mode "trace"). */
export interface TraceReply {
  ok: true;
  channel: string;
  /** The project's ODD for this channel. */
  odd: string | null;
  /** ODD files by the name the models table's `source` uses. */
  sources: Record<string, string>;
  /** [xpath, element, model, behaviour, suppressed], in document order. */
  records: [string, string, string | null, string | null, boolean][];
  models: Record<string, { element: string; behaviour?: string; predicate?: string; desc?: string; source?: string; output?: string }>;
}

export type TraceResult = TraceReply | { ok: false; error: string; traceback?: string };

interface Pending {
  resolve: (r: any) => void;
  progress?: (p: ChunkProgress) => void;
}

let channel: vscode.OutputChannel | undefined;

/** The "ODDity: opm" output channel, shared by the preview and the opm commands. */
export function opmLog(): vscode.OutputChannel {
  return (channel ??= vscode.window.createOutputChannel("ODDity: opm"));
}

/**
 * The long-running Python process (media/opm_preview.py) that transforms
 * documents with opm. Started on the first request and restarted after it
 * exits; Python, opm and the compiled ODDs stay loaded in between.
 */
export class OpmHelper implements vscode.Disposable {
  private proc?: ChildProcess;
  private starting?: Promise<ChildProcess | undefined>;
  private nextId = 1;
  private offered = false;
  /** The installed opm's version was checked this session: warn about it once. */
  private versionChecked = false;
  private readonly pending = new Map<number, Pending>();
  readonly log = opmLog();

  constructor(private readonly context: vscode.ExtensionContext) {}

  transform(req: TransformRequest, progress?: (p: ChunkProgress) => void): Promise<TransformResult> {
    return this.send(req, progress);
  }

  /** Record which model handles each element of `text` in the output channel `channel`. */
  trace(req: { root: string; file: string; text: string; channel: string }): Promise<TraceResult> {
    return this.send({ ...req, mode: "trace" });
  }

  private async send<R>(req: object, progress?: (p: ChunkProgress) => void): Promise<R | { ok: false; error: string }> {
    const proc = await this.process();
    if (!proc?.stdin) {
      return {
        ok: false,
        error:
          "opm was not found. Install it (uv tool install open-processing-model), " +
          "or point the oddity.opm.path or oddity.opm.python setting at it, then reopen the preview.",
      };
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, progress });
      proc.stdin!.write(JSON.stringify({ id, ...req }) + "\n");
    });
  }

  /** Offer the install again on the next start (the user opened a preview anew). */
  allowInstallPrompt(): void {
    this.offered = false;
  }

  /** Stop the process; the next request starts a new one (e.g. after installing opm). */
  restart(): void {
    this.proc?.kill();
    this.proc = undefined;
  }

  dispose(): void {
    this.restart();
  }

  private process(): Promise<ChildProcess | undefined> {
    if (this.proc && this.proc.exitCode === null) {
      return Promise.resolve(this.proc);
    }
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(): Promise<ChildProcess | undefined> {
    let python = await locatePython();
    // Ask once per session: the preview refreshes as you type
    if (!python && !this.offered) {
      this.offered = true;
      if (await offerInstall()) {
        python = await locatePython();
      }
    }
    if (!python) {
      return undefined;
    }
    const script = path.join(this.context.extensionPath, "media", "opm_preview.py");
    this.log.appendLine(`Starting ${python} ${script}`);
    const proc = spawn(python, ["-u", script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => this.log.append(chunk));
    readline.createInterface({ input: proc.stdout! }).on("line", (line) => {
      let reply: { id?: number; progress?: ChunkProgress; ready?: boolean; version?: string | null };
      try {
        reply = JSON.parse(line);
      } catch {
        this.log.appendLine(line);
        return;
      }
      if (reply.ready) {
        this.checkVersion(python!, reply.version);
        return;
      }
      const pending = reply.id !== undefined ? this.pending.get(reply.id) : undefined;
      if (pending && reply.progress) {
        pending.progress?.(reply.progress);
      } else if (pending) {
        this.pending.delete(reply.id!);
        pending.resolve(reply);
      }
    });
    proc.on("error", (err) => this.log.appendLine(`opm helper: ${err.message}`));
    proc.on("exit", (code) => {
      this.log.appendLine(`opm helper exited (${code ?? "killed"})`);
      if (this.proc === proc) {
        this.proc = undefined;
      }
      // Requests the process took with it would wait forever
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.resolve({ ok: false, error: "The opm process stopped. See the “ODDity: opm” output." });
      }
    });
    this.proc = proc;
    return proc;
  }

  private async checkVersion(python: string, version: string | null | undefined): Promise<void> {
    if (this.versionChecked) {
      return;
    }
    this.versionChecked = true;
    if (await checkOpmVersion(python, version, this.log)) {
      // The upgraded opm is loaded on the next request
      this.restart();
    }
  }
}
