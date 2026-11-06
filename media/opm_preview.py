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
import json
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


def _transform(req: dict) -> dict:
    root = Path(req['root'])
    file = Path(req['file'])
    mode = req.get('mode') or 'web'
    _use_project(root)
    project = _project(root)
    # Parse the editor's text with the file's URL, so doc() and relative links
    # resolve against the real file although it may not be saved yet.
    parser = etree.XMLParser(remove_blank_text=False, resolve_entities=False)
    tree = etree.fromstring(req['text'].encode('utf-8'), parser, base_url=str(file)).getroottree()
    output = project.transform(tree, mode=mode, parameters={'input_path': str(file)})
    if isinstance(output, bytes):
        output = output.decode('utf-8', errors='replace')
    return {'ok': True, 'output': output, 'assets': _assets(project, mode)}


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
            reply = _chunk(req) if req.get('mode') == 'chunk' else _transform(req)
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
