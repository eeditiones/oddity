import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const EXISTDB_CONFIG = ".existdb.json";
const ODD_COLLECTION = path.join("resources", "odd");

export interface ExistDbServer {
  server: string;
  user: string;
  password: string;
  root: string;
}

export interface ExistDbAppCredentials {
  user: string;
  password: string;
}

export interface ExistDbConfig {
  servers?: Record<string, ExistDbServer>;
  sync?: { server?: string };
  /** Credentials for TEI Publisher app API calls (e.g. recompile), separate from sync. */
  app?: ExistDbAppCredentials;
}

export interface RecompileContext {
  document: vscode.TextDocument;
  projectRoot: string;
  config: ExistDbConfig;
  appBase: string;
  /** Path of the ODD relative to `resources/odd/` (e.g. `shakespeare.odd`). */
  oddPath: string;
}

/** HTTP base URI for the TEI Publisher app (e.g. `http://127.0.0.1:8080/exist/apps/jinks`). */
export function appBaseUri(server: string, root: string): string {
  const appPath = root.startsWith("/db") ? root.slice(3) : root;
  return server.replace(/\/$/, "") + appPath;
}

/** Walk parents from `startDir` until `.existdb.json` is found. */
export function findExistDbConfig(
  startDir: string
): { projectRoot: string; config: ExistDbConfig } | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const configPath = path.join(dir, EXISTDB_CONFIG);
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(
          fs.readFileSync(configPath, "utf8")
        ) as ExistDbConfig;
        return { projectRoot: dir, config };
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** Pick the server entry named by `sync.server`, or the first in `servers`. */
export function resolveServer(
  config: ExistDbConfig
): ExistDbServer | undefined {
  const servers = config.servers;
  if (!servers || typeof servers !== "object") {
    return undefined;
  }
  const id = config.sync?.server ?? Object.keys(servers)[0];
  if (!id) {
    return undefined;
  }
  const entry = servers[id];
  if (!entry?.server || !entry.root) {
    return undefined;
  }
  return {
    server: entry.server,
    user: entry.user ?? "admin",
    password: entry.password ?? "",
    root: entry.root,
  };
}

/**
 * If `docPath` is under `{projectRoot}/resources/odd/`, return its path
 * relative to that folder; otherwise `undefined`.
 */
export function oddRelativePath(
  projectRoot: string,
  docPath: string
): string | undefined {
  const oddRoot = path.join(projectRoot, ODD_COLLECTION);
  const rel = path.relative(oddRoot, path.resolve(docPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(path.sep).join("/");
}

/** True when `docPath` is a recompilable ODD under `{projectRoot}/resources/odd/`. */
export function isRecompileEligible(docPath: string): boolean {
  if (!docPath.endsWith(".odd")) {
    return false;
  }

  const found = findExistDbConfig(path.dirname(docPath));
  if (!found) {
    return false;
  }

  if (!oddRelativePath(found.projectRoot, docPath)) {
    return false;
  }

  return resolveServer(found.config) !== undefined;
}

/** Gather everything needed to recompile `document`, or `undefined` if ineligible. */
export function recompileContextFor(
  document: vscode.TextDocument
): RecompileContext | undefined {
  const docPath = document.uri.fsPath;
  if (!docPath.endsWith(".odd")) {
    return undefined;
  }

  const found = findExistDbConfig(path.dirname(docPath));
  if (!found) {
    return undefined;
  }

  const oddPath = oddRelativePath(found.projectRoot, docPath);
  if (!oddPath) {
    return undefined;
  }

  const server = resolveServer(found.config);
  if (!server) {
    return undefined;
  }

  return {
    document,
    projectRoot: found.projectRoot,
    config: found.config,
    appBase: appBaseUri(server.server, server.root),
    oddPath,
  };
}

/** Stored app credentials from `.existdb.json`, if configured. */
export function appCredentialsFromConfig(
  config: ExistDbConfig
): ExistDbAppCredentials | undefined {
  const user = config.app?.user?.trim();
  if (!user) {
    return undefined;
  }
  return { user, password: config.app?.password ?? "" };
}

/** Persist `app` credentials into an existing `.existdb.json`. */
export function saveAppCredentials(
  projectRoot: string,
  credentials: ExistDbAppCredentials
): boolean {
  const configPath = path.join(projectRoot, EXISTDB_CONFIG);
  if (!fs.existsSync(configPath)) {
    return false;
  }
  try {
    const config = JSON.parse(
      fs.readFileSync(configPath, "utf8")
    ) as ExistDbConfig;
    config.app = credentials;
    fs.writeFileSync(
      configPath,
      JSON.stringify(config, null, 2) + "\n",
      "utf8"
    );
    return true;
  } catch {
    return false;
  }
}
