import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify");
const sourcemap = process.argv.includes("--sourcemap") || watch;

const common = { bundle: true, minify, sourcemap, logLevel: "info" };

/** Extension host: Node/CommonJS, vscode external. */
const extension = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
};

/** Webview: browser IIFE. Imported CSS is emitted as dist/webview.css. */
const webview = {
  ...common,
  entryPoints: ["src/webview/main.ts"],
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  // Inline the codicon font into the bundled CSS as a data: URL.
  loader: { ".ttf": "dataurl" },
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extension),
    esbuild.context(webview),
  ]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
