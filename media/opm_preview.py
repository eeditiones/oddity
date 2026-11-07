# Preview helper for ODDity: transforms XML with opm on request.
#
# Started by the extension with the Python interpreter opm is installed in.
# Reads one JSON request per line on stdin and writes one JSON reply per line
# on stdout. Anything else opm prints goes to stderr, so it can never corrupt
# the replies.
#
# Request:  {"id": 1, "root": "/project", "file": "/project/data/a.xml",
#            "text": "<TEI …", "mode": "web"}
# Reply:    {"id": 1, "ok": true, "output": "<html…", "assets": {"name": "/abs/path"}}
#       or  {"id": 1, "ok": false, "error": "…", "traceback": "…"}
#
# Mode "chunk" takes "out" (a directory) instead of using "text", and replies
# {"id": 1, "ok": true, "dir": "/out", "landing": "a.xml/001.html"}.
#
# Mode "typst" also takes "typst" (the typst command) and "out" (a directory),
# compiles the Typst output to one SVG per page there, and replies
# {"id": 1, "ok": true, "output": "<typst source>", "dir": "/out",
#  "pages": ["page-1.svg", …]}. With "pdf" (a file) instead of "out", it writes
# a PDF there and replies {"id": 1, "ok": true, "pdf": "/a.pdf"}.
import json
import re
import subprocess
import sys
import traceback
from pathlib import Path

_stdout = sys.stdout
sys.stdout = sys.stderr

from lxml import etree  # noqa: E402
from opm import Project  # noqa: E402

_projects: dict[Path, tuple[float, Project]] = {}
_project_root: Path | None = None


def _use_project(root: Path) -> None:
    """Make root the project Python imports from.

    Most projects have an `extensions` package, so the one imported first would
    shadow the next: drop the previous project's import path and modules before
    root's are used. (As OPM Studio's glue.py does.)
    """
    global _project_root
    import importlib
    if _project_root is not None and _project_root != root:
        prefix = str(_project_root) + '/'
        sys.path[:] = [p for p in sys.path if p != str(_project_root) and not p.startswith(prefix)]
        for name, module in list(sys.modules.items()):
            if (getattr(module, '__file__', None) or '').startswith(prefix):
                del sys.modules[name]
        importlib.invalidate_caches()
    _project_root = root
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def _project(root: Path) -> Project:
    """The project at root, loaded again when its opm.toml has changed."""
    config = root / 'opm.toml'
    mtime = config.stat().st_mtime
    cached = _projects.get(root)
    if cached and cached[0] == mtime:
        return cached[1]
    project = Project.load(config)
    _projects[root] = (mtime, project)
    return project


def _assets(project: Project, mode: str) -> dict[str, str]:
    """The files the mode's template links as assets/<name>, by name."""
    try:
        from opm.assets import resolve_assets
        from opm.output_modes import output_mode
        from opm.transform import template_assets
        sources = resolve_assets(project.root, template_assets(output_mode(mode), project.config))
    except Exception:  # an older opm, or a missing asset: the page still renders
        traceback.print_exc()
        return {}
    return {source.name: str(source) for source in sources}


def _run_transform(req: dict, mode: str) -> tuple[Project, str | bytes]:
    root = Path(req['root'])
    file = Path(req['file'])
    _use_project(root)
    project = _project(root)
    # Parse the editor's text with the file's URL, so doc() and relative links
    # resolve against the real file although it may not be saved yet.
    parser = etree.XMLParser(remove_blank_text=False, resolve_entities=False)
    tree = etree.fromstring(req['text'].encode('utf-8'), parser, base_url=str(file)).getroottree()
    return project, project.transform(tree, mode=mode, parameters={'input_path': str(file)})


def _transform(req: dict) -> dict:
    mode = req.get('mode') or 'web'
    project, output = _run_transform(req, mode)
    if isinstance(output, bytes):
        output = output.decode('utf-8', errors='replace')
    return {'ok': True, 'output': output, 'assets': _assets(project, mode)}


def _typst(req: dict) -> dict:
    """Compile the Typst output to SVG pages in req['out'], or to req['pdf'].

    Typst gets the source on stdin with the XML's folder as its root, as
    `opm transform -t typst` does, so image paths resolve next to the document.
    """
    _, source = _run_transform(req, 'typst')
    if isinstance(source, bytes):
        source = source.decode('utf-8', errors='replace')
    file = Path(req['file'])
    command = [req['typst'], 'compile', '--root', str(file.parent)]
    if req.get('pdf'):
        target = Path(req['pdf'])
        command += ['--format', 'pdf', '-', str(target)]
    else:
        out = Path(req['out'])
        out.mkdir(parents=True, exist_ok=True)
        for old in out.glob('page-*.svg'):
            old.unlink()
        command += ['--format', 'svg', '-', str(out / 'page-{p}.svg')]
    result = subprocess.run(command, input=source.encode('utf-8'), capture_output=True, check=False)
    messages = result.stderr.decode('utf-8', errors='replace').strip()
    if messages:
        sys.stderr.write(messages + '\n')
    if result.returncode != 0:
        raise TypstError(messages or f'typst compile failed with exit status {result.returncode}')
    if req.get('pdf'):
        return {'ok': True, 'pdf': str(target)}
    pages = sorted(out.glob('page-*.svg'), key=lambda p: int(re.sub(r'\D', '', p.name) or 0))
    return {'ok': True, 'output': source, 'dir': str(out), 'pages': [p.name for p in pages]}


class TypstError(Exception):
    """typst compile failed; the message is what Typst reported."""


def _chunk(req: dict) -> dict:
    """Chunk the saved file into req['out'], as `opm chunk` does.

    `chunk` reads the file from disk and names the pages after it, so unsaved
    text cannot be chunked. Returns the page to open first: the document's
    first page rather than the collection index.
    """
    root = Path(req['root'])
    file = Path(req['file'])
    out = Path(req['out'])
    _use_project(root)
    project = _project(root)
    if not project.config.chunking:
        raise ValueError('This project has no [chunking] section in opm.toml, so there is nothing to chunk.')
    project.chunk(file, format='html', output_dir=out, overwrite=True)
    pages = sorted(p for p in (out / file.name).glob('*.html') if p.name != 'browse.html')
    landing = pages[0] if pages else out / 'index.html'
    return {'ok': True, 'dir': str(out), 'landing': landing.relative_to(out).as_posix()}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req: dict = {}
        try:
            req = json.loads(line)
            mode = req.get('mode')
            reply = _chunk(req) if mode == 'chunk' else _typst(req) if mode == 'typst' else _transform(req)
        except Exception as e:
            reply = {'ok': False, 'error': f'{type(e).__name__}: {e}', 'traceback': traceback.format_exc()}
        reply['id'] = req.get('id')
        _stdout.write(json.dumps(reply) + '\n')
        _stdout.flush()


if __name__ == '__main__':
    import opm
    sys.stderr.write(f'opm {getattr(opm, "__version__", "?")} ready\n')
    sys.stderr.flush()
    main()
