import { Marked } from "marked";
import markedFootnote from "marked-footnote";

/** Output modes the preview renders. */
export const PREVIEW_MODES = ["web", "print", "markdown"] as const;
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
      return inject(output, PAGED_BOOT + `<script src="${pagedJs}" onerror="parent.postMessage({oddityPreview:'error',message:'Paged.js could not be loaded'},'*')"></script>`);
    case "markdown":
      return inject(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${MARKDOWN_CSS}</style></head><body>${markdown.parse(output)}</body></html>`,
        SCROLL_KEEPER + READY
      );
    default:
      return inject(output, SCROLL_KEEPER + READY);
  }
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
 * Remember the scroll position in sessionStorage (the frame's origin is the
 * preview server, so it survives the reload) and restore it after a refresh.
 */
const SCROLL_FN = /* js */ `
window.__oddityScroll = {
  restore: function () {
    try {
      var y = +sessionStorage.getItem('oddity-scroll') || 0;
      if (y) window.scrollTo(0, y);
    } catch (e) {}
    var t;
    window.addEventListener('scroll', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        try { sessionStorage.setItem('oddity-scroll', String(window.scrollY)); } catch (e) {}
      }, 100);
    }, { passive: true });
  }
};
`;

const SCROLL_KEEPER = `<script>${SCROLL_FN}window.__oddityScroll.restore();</script>`;
const READY = `<script>parent.postMessage({oddityPreview:'done'},'*');</script>`;

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

const MARKDOWN_CSS =
  "body{font:15px/1.6 system-ui,sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 1rem;color:#222;background:#fff}pre,code{font-family:ui-monospace,monospace;background:#f3f3f0}pre{padding:.75rem;overflow:auto}blockquote{margin-left:0;padding-left:1rem;border-left:3px solid #ccc;color:#555}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.25rem .5rem}img{max-width:100%}.footnotes{margin-top:2rem;border-top:1px solid #ccc;font-size:.9em}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}";
