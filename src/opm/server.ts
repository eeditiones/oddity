import { randomBytes } from "crypto";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as path from "path";
import * as vscode from "vscode";

/**
 * One preview's current output and the files it may link: either a single
 * page (`html`, with its `assets`) or a folder of pages written by a chunk run
 * (`dir`, whose HTML pages pass through `page` on the way out).
 */
export interface PreviewSite {
  html?: string;
  /** assets/<name> → file or folder, as `opm transform -o` copies them. */
  assets?: Record<string, string>;
  /** Folder of a chunk run's pages, served as the site's root. */
  dir?: string;
  /** Page of `dir` to open first. */
  landing?: string;
  /** Applied to every HTML page served from `dir`. */
  page?: (html: string) => string;
  /** Folder of the XML file: other relative links resolve against it. */
  docDir: string;
  /** Project root: nothing outside it is served, except assets and `dir`. */
  root: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * A local HTTP server for the preview frames, standing in for the folder
 * `opm transform -o` would write: the page, its `assets/`, and the files beside
 * the XML that the output links (images, facsimiles). Rendering from a real
 * origin keeps relative links, scripts and Paged.js working as they do in a
 * browser.
 *
 * Listens on 127.0.0.1 only; every path starts with a random token, so other
 * pages in a browser cannot guess their way to project files.
 */
export class PreviewServer implements vscode.Disposable {
  private server?: http.Server;
  private listening?: Promise<string>;
  private readonly token = randomBytes(16).toString("hex");
  private readonly sites = new Map<string, PreviewSite>();

  constructor(private readonly extensionPath: string) {}

  /** Publish a preview's page; returns the URL to load it from. */
  async publish(id: string, site: PreviewSite): Promise<vscode.Uri> {
    this.sites.set(id, site);
    const base = await this.start();
    const page = site.dir ? site.landing ?? "index.html" : "index.html";
    return vscode.Uri.parse(`${base}/${this.token}/p/${id}/${encodeURI(page)}`);
  }

  /** Path of the bundled Paged.js polyfill on this server. */
  get pagedJsPath(): string {
    return `/${this.token}/_oddity/paged.polyfill.min.js`;
  }

  remove(id: string): void {
    this.sites.delete(id);
  }

  /** Origin to allow as the webview's frame source. */
  async origin(): Promise<string> {
    return this.start();
  }

  dispose(): void {
    this.server?.close();
  }

  private start(): Promise<string> {
    this.listening ??= new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on("error", reject);
      server.listen(0, "127.0.0.1", async () => {
        const { port } = server.address() as AddressInfo;
        // Remote windows (SSH, containers) reach the port through a forward
        const external = await vscode.env.asExternalUri(
          vscode.Uri.parse(`http://127.0.0.1:${port}`)
        );
        resolve(external.toString(true).replace(/\/$/, ""));
      });
      this.server = server;
    });
    return this.listening;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (parts[0] !== this.token) {
      // A link from the site root (`/people/x.html`) on one of our pages: the
      // root is that preview's output folder, as with `opm serve`
      const from = new URL(req.headers.referer ?? "/", "http://localhost").pathname;
      const site = new RegExp(`^/${this.token}/p/([0-9a-f]+)/`).exec(from);
      if (site && this.sites.has(site[1])) {
        res.writeHead(302, { Location: `/${this.token}/p/${site[1]}${url.pathname}${url.search}` });
        res.end();
        return;
      }
      return notFound(res);
    }
    if (parts[1] === "_oddity" && parts[2] === "paged.polyfill.min.js") {
      return this.sendFile(res, path.join(this.extensionPath, "dist", "paged.polyfill.min.js"));
    }
    const site = parts[1] === "p" ? this.sites.get(parts[2]) : undefined;
    if (!site) {
      return notFound(res);
    }
    const rest = parts.slice(3);
    if (site.html !== undefined && rest.length === 1 && rest[0] === "index.html") {
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
      res.end(site.html);
      return;
    }
    if (site.dir) {
      const file = path.join(site.dir, ...rest);
      if (inside(file, site.dir) && isFile(file)) {
        return /\.html?$/i.test(file) && site.page
          ? this.sendPage(res, file, site.page)
          : this.sendFile(res, file);
      }
      // A page the last run no longer wrote (fewer chunks now): its first page
      if (/\.html?$/i.test(file) && site.landing) {
        res.writeHead(302, { Location: `/${this.token}/p/${parts[2]}/${encodeURI(site.landing)}` });
        res.end();
        return;
      }
    }
    // An asset may live anywhere opm.toml points, but never above its own entry
    const asset = rest[0] === "assets" && rest[1] ? site.assets?.[rest[1]] : undefined;
    const [base, file] = asset
      ? [asset, path.join(asset, ...rest.slice(2))]
      : [site.root, path.join(site.docDir, ...rest)];
    if (!inside(file, base)) {
      return notFound(res);
    }
    this.sendFile(res, file);
  }

  private sendPage(res: http.ServerResponse, file: string, page: (html: string) => string): void {
    fs.readFile(file, "utf8", (err, html) => {
      if (err) {
        return notFound(res);
      }
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
      res.end(page(html));
    });
  }

  private sendFile(res: http.ServerResponse, file: string): void {
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        return notFound(res);
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(file).pipe(res);
    });
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function inside(file: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": TYPES[".txt"] });
  res.end("Not found");
}
