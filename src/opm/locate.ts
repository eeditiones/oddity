import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export const PACKAGE = "open-processing-model";

/**
 * The Python interpreter opm is installed in, or undefined when there is none.
 *
 * Order: the `oddity.opm.python` setting; else the interpreter named on the
 * first line of the `opm` script (the `oddity.opm.path` setting, or `opm` on
 * the PATH), which is how uv tool, pipx and pip install it; on Windows, the
 * python.exe in the same Scripts folder as opm.exe. Each candidate must be
 * able to import opm.
 */
export async function locatePython(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("oddity.opm");
  const explicit = config.get<string>("python")?.trim();
  if (explicit) {
    return (await canImportOpm(explicit)) ? explicit : undefined;
  }
  const opm = config.get<string>("path")?.trim() || findOnPath("opm") || userBinOpm();
  const candidates = opm && fs.existsSync(opm) ? interpretersFor(opm) : [];
  // Installed with `uv tool install`: the tool's own environment. Needed on
  // Windows, where opm.exe is a launcher without a readable interpreter line.
  candidates.push(...(await uvToolPython()));
  for (const python of candidates) {
    if (await canImportOpm(python)) {
      return python;
    }
  }
  return undefined;
}

function uvToolPython(): Promise<string[]> {
  const uv = findOnPath("uv");
  if (!uv) {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    execFile(uv, ["tool", "dir"], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const env = path.join(stdout.trim(), PACKAGE);
      resolve(
        process.platform === "win32"
          ? [path.join(env, "Scripts", "python.exe")]
          : [path.join(env, "bin", "python3"), path.join(env, "bin", "python")]
      );
    });
  });
}

function interpretersFor(opm: string): string[] {
  const found: string[] = [];
  if (process.platform === "win32") {
    found.push(path.join(path.dirname(opm), "python.exe"));
  }
  try {
    const head = fs.readFileSync(opm, { encoding: "latin1" }).slice(0, 512);
    const shebang = /^#!\s*(\S+)(?:[ \t]+(\S+))?/.exec(head);
    if (shebang) {
      // `#!/usr/bin/env python3` names the program as its argument
      found.push(path.basename(shebang[1]) === "env" && shebang[2] ? shebang[2] : shebang[1]);
    }
  } catch {
    // not readable: no shebang to go by
  }
  return found;
}

function canImportOpm(python: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(python, ["-c", "import opm"], { timeout: 20000 }, (err) => resolve(!err));
  });
}

/**
 * Where uv tool and pipx put `opm`. VS Code's PATH may lack this folder, e.g.
 * right after installing, or when VS Code was started from the dock.
 */
function userBinOpm(): string | undefined {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    return undefined;
  }
  const opm = path.join(home, ".local", "bin", process.platform === "win32" ? "opm.exe" : "opm");
  return fs.existsSync(opm) ? opm : undefined;
}

/**
 * The `typst` command, or undefined when there is none: the `oddity.opm.typst`
 * setting, else `typst` on the PATH, else the folders installers use that a
 * VS Code started from the dock may not have on its PATH.
 */
export function locateTypst(): string | undefined {
  const explicit = vscode.workspace.getConfiguration("oddity.opm").get<string>("typst")?.trim();
  if (explicit) {
    return isFile(explicit) ? explicit : undefined;
  }
  const found = findOnPath("typst");
  if (found) {
    return found;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const exe = process.platform === "win32" ? "typst.exe" : "typst";
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".cargo", "bin"), path.join(home, ".local", "bin")];
  return dirs.map((d) => path.join(d, exe)).find(isFile);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (dir && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Tell the user opm is missing and offer to install it in a terminal, with the
 * first of uv, pipx or pip that is available. Resolves true once an install
 * terminal has closed, so the caller can look for opm again.
 */
export async function offerInstall(feature = "The preview"): Promise<boolean> {
  const install = "Install opm";
  const settings = "Settings";
  const choice = await vscode.window.showWarningMessage(
    `${feature} needs opm (the Open Processing Model), which was not found.`,
    install,
    settings
  );
  if (choice === settings) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "oddity.opm");
    return false;
  }
  if (choice !== install) {
    return false;
  }
  const command = findOnPath("uv")
    ? `uv tool install ${PACKAGE}`
    : findOnPath("pipx")
      ? `pipx install ${PACKAGE}`
      : `${process.platform === "win32" ? "py" : "python3"} -m pip install --user ${PACKAGE}`;
  return runInTerminal("Install opm", command);
}

/**
 * The oldest opm the preview helper (media/opm_preview.py) works with. Raise it
 * when the helper starts to use something only a newer opm has.
 */
export const MIN_OPM_VERSION = "0.10.0";

/**
 * A version as [release numbers, stage, stage number], ordered as Python's
 * packaging does for the forms opm uses: 0.11.0.dev0 < 0.11.0a1 < 0.11.0rc1 <
 * 0.11.0 < 0.11.0.post1. A local part (+g1234abc) is ignored. Undefined when
 * the text is not a version.
 */
function parseVersion(text: string): [number[], number, number] | undefined {
  const m = /^v?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:[-_.]?(post|rev|r)[-_.]?(\d*))?(?:[-_.]?(dev)[-_.]?(\d*))?(?:\+.*)?$/i.exec(
    text.trim()
  );
  if (!m) {
    return undefined;
  }
  const release = m[1].split(".").map(Number);
  const pre = m[2]?.toLowerCase();
  // Stage: dev release of the version itself, pre-release, final, post-release
  const stage = m[4] ? 3 : pre ? 1 : m[6] ? 0 : 2;
  const num = Number((m[4] ? m[5] : pre ? m[3] : m[6] ? m[7] : "0") || "0");
  return [release, stage, num];
}

/** Negative, zero or positive as version a is older than, equal to or newer than b. */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    return undefined;
  }
  for (let i = 0; i < Math.max(pa[0].length, pb[0].length); i++) {
    const d = (pa[0][i] ?? 0) - (pb[0][i] ?? 0);
    if (d) {
      return d;
    }
  }
  return pa[1] - pb[1] || pa[2] - pb[2];
}

/** A development build of opm, e.g. installed from a checkout of its main branch. */
export function isDevVersion(version: string): boolean {
  return /[-_.]?dev\d*(\+.*)?$/i.test(version.trim()) || version.includes("+");
}

/**
 * Check the opm that `python` has against [MIN_OPM_VERSION]. A development
 * build or a release newer than oddity knows is only noted in `log`; an older
 * one gets a warning that offers to upgrade it. Resolves true once an upgrade
 * terminal has closed, so the caller can restart opm.
 */
export async function checkOpmVersion(
  python: string,
  version: string | null | undefined,
  log: vscode.OutputChannel
): Promise<boolean> {
  // opm reports "0" when it has no package metadata (run from a source tree)
  const order = version && version !== "0" ? compareVersions(version, MIN_OPM_VERSION) : undefined;
  if (order === undefined) {
    log.appendLine(`Could not tell which opm version is installed (${version ?? "none reported"}).`);
    return false;
  }
  if (isDevVersion(version!)) {
    log.appendLine(`Using a development build of opm (${version}).`);
  }
  if (order >= 0) {
    return false;
  }
  const upgrade = "Upgrade opm";
  const choice = await vscode.window.showWarningMessage(
    `ODDity needs opm ${MIN_OPM_VERSION} or later, but opm ${version} is installed. ` +
      "Some preview features may not work until you upgrade it.",
    upgrade
  );
  return choice === upgrade ? runInTerminal("Upgrade opm", upgradeCommand(python)) : false;
}

/** How to upgrade the opm installed in `python`, going by where that is. */
function upgradeCommand(python: string): string {
  const p = python.replace(/\\/g, "/");
  if (/\/uv\/tools\//.test(p) && findOnPath("uv")) {
    return `uv tool upgrade ${PACKAGE}`;
  }
  if (/\/pipx\/venvs\//.test(p) && findOnPath("pipx")) {
    return `pipx upgrade ${PACKAGE}`;
  }
  const quoted = /\s/.test(python) ? `"${python}"` : python;
  return `${quoted} -m pip install --upgrade ${PACKAGE}`;
}

/**
 * Run `command` in a new terminal that closes when it succeeds. Resolves true
 * once the terminal has closed.
 */
function runInTerminal(name: string, command: string): Promise<boolean> {
  const terminal = vscode.window.createTerminal({ name });
  terminal.show();
  // `exit` closes the terminal when the install is done, which ends the wait
  terminal.sendText(`${command} && exit`);
  return new Promise((resolve) => {
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        sub.dispose();
        resolve(true);
      }
    });
  });
}
