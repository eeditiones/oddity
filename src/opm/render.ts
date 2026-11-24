import { Marked } from "marked";
import markedFootnote from "marked-footnote";

/** Output modes the preview renders. */
export const PREVIEW_MODES = ["web", "print", "markdown", "chunk", "typst"] as const;
export type PreviewMode = (typeof PREVIEW_MODES)[number];
export const isPreviewMode = (m: unknown): m is PreviewMode =>
  PREVIEW_MODES.includes(m as PreviewMode);

/**
 * Turn opm's output into the page the preview frame shows: web output as is,
 * print output paginated by Paged.js, Markdown rendered to HTML. Every page
 * keeps its scroll position across refreshes and tells the panel when it is
 * ready (`oddityPreview` messages).
 */
export function previewPage(mode: PreviewMode, output: string, pagedJs: string): string {
  switch (mode) {
    case "print":
      return inject(output, PAGED_BOOT + `<script src="${pagedJs}" onerror="parent.postMessage({oddityPreview:'error',message:'Paged.js could not be loaded'},'*')"></script>` + THEME);
    case "markdown":
      return inject(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${MARKDOWN_CSS}</style></head><body>${markdown.parse(output)}</body></html>`,
        SCROLL_KEEPER + READY + THEME
      );
    default:
      return inject(output, SCROLL_KEEPER + READY + THEME);
  }
}

/**
 * A page of a chunk run, on its way to the preview frame: keeps its scroll
 * position and tells the panel which page is showing, so a refresh reloads
 * that page instead of going back to the first.
 */
export function chunkPage(html: string): string {
  return inject(html, SCROLL_KEEPER + READY + THEME);
}

/**
 * Typst's pages, one SVG each, as sheets. `v` busts the cache: the files keep
 * their names from one compile to the next.
 */
export function typstPage(pages: string[], v: number): string {
  const imgs = pages
    .map((p, i) => `<img class="sheet" src="${encodeURI(p)}?v=${v}" alt="Page ${i + 1}">`)
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${TYPST_CSS}</style></head><body>${imgs}
<script>${SCROLL_FN}
(function () {
  var imgs = Array.prototype.slice.call(document.images), left = imgs.length, failed = false;
  function one(e) {
    if (e && e.type === 'error') failed = true;
    if (--left > 0) return;
    window.__oddityScroll.restore();
    parent.postMessage(failed
      ? { oddityPreview: 'error', message: 'A page could not be loaded' }
      : { oddityPreview: 'done', pages: imgs.length }, '*');
  }
  if (!left) { left = 1; one(); }
  imgs.forEach(function (img) {
    if (img.complete) one();
    else { img.addEventListener('load', one); img.addEventListener('error', one); }
  });
})();
</script>${THEME}</body></html>`;
}

const markdown = new Marked().use(markedFootnote());

/** Put scripts at the end of the body (or document). */
function inject(html: string, scripts: string): string {
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i, scripts + "</body>");
  }
  if (/<\/html\s*>/i.test(html)) {
    return html.replace(/<\/html\s*>/i, scripts + "</html>");
  }
  return html + scripts;
}

/**
 * Remember each page's scroll position in sessionStorage (the frame's origin
 * is the preview server, so it survives the reload) and restore it after a
 * refresh.
 */
const SCROLL_FN = /* js */ `
window.__oddityScroll = {
  restore: function () {
    var key = 'oddity-scroll:' + location.pathname;
    try {
      var y = +sessionStorage.getItem(key) || 0;
      if (y) window.scrollTo(0, y);
    } catch (e) {}
    var t;
    window.addEventListener('scroll', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        try { sessionStorage.setItem(key, String(window.scrollY)); } catch (e) {}
      }, 100);
    }, { passive: true });
  }
};
`;

const SCROLL_KEEPER = `<script>${SCROLL_FN}window.__oddityScroll.restore();</script>`;
const READY = `<script>parent.postMessage({oddityPreview:'done',path:location.pathname},'*');</script>`;

/**
 * The preview's color theme, driven by the panel's Theme menu ("dark" or
 * "light"). Sets `data-oddity-theme` and `color-scheme` on the root element,
 * so ODD stylesheets can key on them and the UA chrome (scrollbars, form
 * controls, canvas) follows. It also rewrites `prefers-color-scheme` media
 * rules of same-origin stylesheets to match the chosen theme: in a webview
 * iframe that media feature follows the OS, not VS Code, which is why the
 * preview could not be switched before. The choice persists in
 * sessionStorage (same origin as the scroll keeper), so it survives
 * refreshes; with nothing stored, the page asks the panel.
 */
const THEME = `<script>
(function () {
  var KEY = "oddity-theme";
  var originals = new WeakMap();
  function rewriteList(list, owner, theme) {
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!(r instanceof CSSMediaRule)) continue;
      var cond = originals.get(r) || r.conditionText || r.media.mediaText || "";
      var m = /prefers-color-scheme:\\s*(dark|light)/i.exec(cond);
      if (m) {
        if (!originals.has(r)) originals.set(r, cond);
        var active = (m[1].toLowerCase() === "dark") === (theme === "dark");
        var rest = cond.replace(/\\(\\s*prefers-color-scheme:\\s*(dark|light)\\s*\\)/i, "")
          .replace(/^\\s*and\\s+|\\s+and\\s*$/i, "").replace(/^[,\\s]+|[,\\s]+$/g, "").trim();
        var want = active ? (rest || "all") : "not all";
        if ((r.conditionText || "") !== want) {
          var set = false;
          try { r.conditionText = want; set = r.conditionText === want; } catch (e) {}
          if (!set && owner && owner.deleteRule) {
            try {
              var inner = "";
              for (var j = 0; j < r.cssRules.length; j++) inner += r.cssRules[j].cssText + "\\n";
              owner.deleteRule(i);
              owner.insertRule("@media " + want + "{" + inner + "}", i);
              originals.set(list[i], cond);
              i--;
            } catch (e) {}
          }
        }
      }
      if (r.cssRules) rewriteList(r.cssRules, r, theme);
    }
  }
  function rewriteAll(theme) {
    for (var i = 0; i < document.styleSheets.length; i++) {
      try { rewriteList(document.styleSheets[i].cssRules, document.styleSheets[i], theme); } catch (e) {}
    }
  }
  function current() { return document.documentElement.getAttribute("data-oddity-theme"); }
  function apply(t) {
    if (t !== "dark" && t !== "light") return;
    var root = document.documentElement;
    root.setAttribute("data-oddity-theme", t);
    root.style.colorScheme = t;
    try { sessionStorage.setItem(KEY, t); } catch (e) {}
    rewriteAll(t);
  }
  window.addEventListener("message", function (e) {
    if (e.data && (e.data.oddityTheme === "dark" || e.data.oddityTheme === "light")) apply(e.data.oddityTheme);
  });
  // Stylesheets added later (Paged.js rebuilds the DOM, links load async)
  new MutationObserver(function () {
    var t = current();
    if (t) rewriteAll(t);
  }).observe(document.documentElement, { childList: true, subtree: true });
  var stored = null;
  try { stored = sessionStorage.getItem(KEY); } catch (e) {}
  if (stored === "dark" || stored === "light") apply(stored);
  else parent.postMessage({ oddityThemeRequest: true }, "*");
  window.addEventListener("load", function () { var t = current(); if (t) rewriteAll(t); });
})();
</script>
<style>
  html[data-oddity-theme="dark"] { background: #1e1e1e; }
  html[data-oddity-theme="light"] { background: #fff; }
</style>`;

/** Sheet look for the paginated print preview, from OPM Studio. */
const PAGED_CSS = /* css */ `
@media screen {
  html, body { margin: 0 !important; max-width: none !important; padding: 0 !important; background: #efece4 !important; }
  .pagedjs_pages { display: flex !important; flex-direction: column !important; align-items: center !important; width: 100% !important; margin: 0 auto !important; }
  .pagedjs_page {
    background: #fff !important;
    box-shadow: 0 1px 2px rgba(31,29,26,.10), 0 4px 10px rgba(31,29,26,.08), 0 12px 28px rgba(31,29,26,.10) !important;
    border-radius: 2px; margin: 12mm 0 0 !important; flex-shrink: 0 !important; flex-grow: 0 !important;
  }
  .pagedjs_page:last-of-type { margin-bottom: 12mm !important; }
  .pagedjs_first_page { margin-left: 0 !important; }
  /* Dark theme: dim the canvas around the pages; the pages stay paper white,
     the print CSS assumes it */
  html[data-oddity-theme=dark], html[data-oddity-theme=dark] body { background: #161616 !important; }
  html[data-oddity-theme=dark] .pagedjs_page {
    box-shadow: 0 1px 2px rgba(0,0,0,.5), 0 4px 10px rgba(0,0,0,.4), 0 12px 28px rgba(0,0,0,.45) !important;
  }
}
`;

/**
 * Paged.js setup. The sheet CSS goes in after pagination because Paged.js
 * rebuilds the DOM and drops screen rules while it works.
 */
const PAGED_BOOT = `<script>${SCROLL_FN}
window.PagedConfig = {
  auto: true,
  after: function (flow) {
    var s = document.createElement('style');
    s.textContent = ${JSON.stringify(PAGED_CSS)};
    document.head.appendChild(s);
    window.__oddityScroll.restore();
    parent.postMessage({ oddityPreview: 'done', pages: flow && flow.total }, '*');
  }
};
</script>`;

/** The sheet look of the print preview, for Typst's pages. */
const TYPST_CSS = /* css */ `
html, body { margin: 0; padding: 0; background: #efece4; }
body { display: flex; flex-direction: column; align-items: center; padding: 12mm 12px; gap: 12mm; box-sizing: border-box; }
.sheet {
  display: block; max-width: 100%; height: auto; background: #fff; border-radius: 2px;
  box-shadow: 0 1px 2px rgba(31,29,26,.10), 0 4px 10px rgba(31,29,26,.08), 0 12px 28px rgba(31,29,26,.10);
}
/* Dark theme: dim the canvas; the SVG sheets keep their own colors */
html[data-oddity-theme=dark], html[data-oddity-theme=dark] body { background: #161616; }
html[data-oddity-theme=dark] .sheet {
  box-shadow: 0 1px 2px rgba(0,0,0,.5), 0 4px 10px rgba(0,0,0,.4), 0 12px 28px rgba(0,0,0,.45);
}
`;

const MARKDOWN_CSS =
  "body{font:15px/1.6 system-ui,sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 1rem;color:#222;background:#fff}pre,code{font-family:ui-monospace,monospace;background:#f3f3f0}pre{padding:.75rem;overflow:auto}blockquote{margin-left:0;padding-left:1rem;border-left:3px solid #ccc;color:#555}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.25rem .5rem}img{max-width:100%}.footnotes{margin-top:2rem;border-top:1px solid #ccc;font-size:.9em}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}" +
  "html[data-oddity-theme=dark] body{color:#d4d4d4;background:#1e1e1e}html[data-oddity-theme=dark] pre,html[data-oddity-theme=dark] code{background:#2d2d2d}html[data-oddity-theme=dark] blockquote{border-left-color:#555;color:#a8a8a8}html[data-oddity-theme=dark] td,html[data-oddity-theme=dark] th{border-color:#555}html[data-oddity-theme=dark] .footnotes{border-top-color:#555}";
