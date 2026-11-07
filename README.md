<p align="center">
  <img src="media/oddity_logo_final.png" alt="ODDity" width="440">
</p>

Authoring support for TEI **ODD** (`.odd`) files in VS Code with a focus on [TEI Processing Model](https://tei-publisher.org/doc/documentation.xml?id=odd#odd) transformations. The extension was created as a companion for [TEI Publisher's](https://tei-publisher.org/index.html) web-based ODD editor.

ODD files are TEI XML, so general editing — validation, completion, hover,
formatting — is handled by the [Red Hat XML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-xml)
(LemMinX), which this extension declares as a dependency and installs
automatically. On top of that, TEI ODD Tools adds the things that are specific
to how ODDs are organised.

## Features

### ODD-aware outline

The Outline view (and breadcrumbs) is reorganised for `.odd` files. Instead of
the raw XML tree (`TEI ▸ text ▸ body ▸ schemaSpec ▸ …`), you get:

- a `<tagsDecl>` section listing custom `<behaviour>` definitions (`ident · output`),
  `<rendition>` entries (`xml:id` or `source`), and `<namespace>` declarations;
- each `<schemaSpec>` as a container (labelled by `ident`, with `source` in the
  detail when present), holding in document order:
  - `<moduleRef>` entries (`key`, with `include` / `except` in the detail);
  - `<dataSpec>`, `<macroSpec>`, and `<classSpec>` entries (labelled by `ident`,
    with `mode` / `type` in the detail where relevant);
  - `<elementSpec>` entries, each with nested `<model>` / `<modelGrp>` /
    `<modelSequence>` rules labelled by `output · predicate · behaviour` (or
    the wrapper name in place of `behaviour`). Parts that are absent are
    omitted. Groups and sequences keep their nested models as children.

The generic XML outline is suppressed for `.odd` files (via
`xml.symbols.filters`) so the two don't compete. Other `.xml` files keep their
normal XML outline.

### Add Element Spec

Structural element/attribute completion inside an ODD is left to the Red Hat XML
extension, which drives it from the bound schema (it even offers the `behaviour`
values, since they are enumerated in `teipublisher_odds.xsd`). The one thing the
schema cannot know is *which* idents the inherited ODD defines — so that is
provided as a command instead.

The **ODD: Add Element Spec** command (command palette or editor context menu)
adds an `<elementSpec>` to the document's `<schemaSpec>`. It shows a picker where
you either:

- pick an ident defined in the **inherited** ODD — when the schemaSpec declares
  `source="…"` (e.g. `<schemaSpec … source="teipublisher.odd">`), each
  `<elementSpec>` from that parent ODD is offered by `ident`. Choosing one copies
  in the full definition with `mode="change"`, ready to adjust. Idents already
  present in the current schemaSpec are not offered again; or
- type a new ident — inserts a blank `mode` / `<model>` scaffold as a snippet,
  leaving `behaviour` for schema-driven completion to fill.

The spec is inserted immediately after the `<elementSpec>` the cursor sits in,
or — when the cursor is elsewhere — on the line before `</schemaSpec>`. The editor
scrolls to the insertion point.

The parent ODD is located by `source`, resolved in order: a sibling file next to
the current ODD (the normal TEI Publisher layout, and the version-accurate one),
then any file of that name in the workspace, and finally a copy bundled with the
extension (`schemas/teipublisher.odd`) as an offline fallback. The copy is taken
verbatim from the parent, so `xml:space="preserve"` template content is kept
intact.

### Graphical ODD editor

An opt-in, form-based editor for the ODD processing model, reproducing the
fields of the old TEI Publisher web editor. The plain XML text editor stays the
default; open the graphical view with the **ODD: Open Graphical Editor** command
(or the editor-title / explorer context menu), which opens it beside the source.

Both views stay live-synced through the underlying file: edits in the form are
written back, and edits in the text editor refresh the form. The left panel lists
every `<elementSpec>` (with add / jump-to-filter). Adding an element uses the
same inheritance logic as **ODD: Add Element Spec**: click **+** with an empty
field to pick from the parent ODD, or type an ident to inherit its definition
when available (otherwise a blank scaffold is inserted).

Edits are written back **surgically**: saving never regenerates the document, or
even a whole `<elementSpec>`.

The form is **schema-aware about what each kind of rule may hold**, so it can't
be used to build ODD the schema rejects.

### Automatic schema binding

ODDs are validated against `teipublisher_odds.xsd`, which is bundled with the
extension. If an ODD already points at a resolvable schema through an
`<?xml-model href="…"?>` processing instruction, that is left untouched.
Otherwise a managed entry is added to `xml.fileAssociations` so the bundled
schema applies anyway.

Disable this with `"oddity.autoBindSchema": false`.

### Recompile in TEI Publisher

The **ODD: Recompile in TEI Publisher** command (command palette, editor title bar,
or editor context menu) triggers ODD compilation on a running eXist/TEI Publisher
instance. It sends `POST /api/odd?odd=…` to the app API and shows a summary
of the compilation report in a notification.

This only applies when:

- the project root contains a `.existdb.json` (as used by the
  [exist-db VS Code extension](https://marketplace.visualstudio.com/items?itemName=eXist-db.existdb-vscode));
  server URL, credentials, and app root are read from there;
- the ODD file lives under `resources/odd/` relative to that project root.

Recompilation operates on the **copy in eXist**, not the local file. Save your
changes and ensure they are synced or deployed to the database (e.g. via
exist-db sync) before recompiling.

### opm preview

In an [opm](https://github.com/eeditiones/open-processing-model) project (a
folder with an `opm.toml`), **opm: Open opm Preview to the Side** shows the
open XML file transformed by opm, as `opm transform` would produce it. The ODD,
templates and assets are the ones `opm.toml` names. Pick the output mode
(web, print or Markdown) in the panel; print output is paginated with
Paged.js. **Open output** shows the raw output in a read-only editor tab, which
keeps following the preview.

The preview follows your typing without saving, and refreshes whenever a file
of the project (the ODD, CSS, templates, `opm.toml`) is saved.

The **chunk** mode shows the pages `opm chunk` writes for the file, following
the project's `[chunking]` settings, and lets you browse between them. It works
from the saved file, so it refreshes when you save; the page you are reading
stays open across refreshes.

The **typst** mode shows the pages Typst compiles from the project's Typst
output, following your typing like the other modes. **Export PDF** compiles the
same output to a PDF file. The mode is only offered when the `typst` command is
installed (see [typst.app](https://typst.app/open-source/)); ODDity looks for it
on the PATH and in the usual install folders, or set `oddity.opm.typst`. After
installing it, run **Restart opm Preview Process** to make the mode appear.

It needs opm installed (`uv tool install open-processing-model`); if it is
missing, ODDity offers to install it. ODDity looks for `opm` on the PATH and in
`~/.local/bin`; set `oddity.opm.path`, or `oddity.opm.python` for an
interpreter in a virtual environment, if it lives elsewhere.

## Commands

All commands are listed under the **ODD** category in the command palette
(<kbd>Ctrl+Shift+P</kbd> / <kbd>Cmd+Shift+P</kbd>).

| Command | Where | What it does |
| --- | --- | --- |
| **Open Graphical Editor** | Command palette; editor title bar; explorer / editor context menu (source view) | Open the form-based graphical editor for the current `.odd` file. |
| **Open elementSpec in Graphical Editor** | Command palette; editor context menu (source view, cursor inside an `<elementSpec>`) | Open the graphical editor beside the source and select the `<elementSpec>` at the cursor. If the graphical editor is already open, focus it and jump to that spec. |
| **Add &lt;elementSpec&gt;** | Command palette; editor context menu (source view) | Insert a new `<elementSpec>` into `<schemaSpec>` — pick an ident from the inherited ODD or type a new one. Inserts after the spec under the cursor, or before `</schemaSpec>`. |
| **Go to elementSpec** | Command palette; <kbd>Ctrl+F</kbd> / <kbd>Cmd+F</kbd> (graphical editor) | Quick-pick any `<elementSpec>` in the graphical editor and jump to it. |
| **Recompile ODD on server** | Command palette; editor title bar; editor context menu | Trigger ODD compilation on a running TEI Publisher instance (when the project is eligible; see above). |
| **Open opm Preview to the Side** | Command palette; editor title bar; explorer context menu (XML files in an opm project) | Show the XML file transformed by opm, updated as you type (see above). |
| **Restart opm Preview Process** | Command palette | Restart the opm process behind the preview, e.g. after updating opm. |

## Requirements

- VS Code 1.84+
- `redhat.vscode-xml` (installed automatically as a dependency)

## Development

```sh
npm install
npm run compile      # or: npm run watch
```

Press <kbd>F5</kbd> to launch an Extension Development Host, then open an `.odd`
file.

The bundled schema under `schemas/` (`teipublisher_odds.xsd` plus its `ns1.tmp`,
`teix.tmp`, `xml.tmp` fragments) is a snapshot generated from
`teipublisher_odds.odd` in TEI Publisher; refresh it from there when the ODD
schema changes.

`schemas/teipublisher.odd` is the bundled fallback parent ODD used by
**ODD: Add Element Spec** for inheritance. It is a copy of
`jinks/profiles/base10/resources/odd/teipublisher.odd`; refresh it from there
when the base profile changes.
