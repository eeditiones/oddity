<p align="center">
  <img src="media/oddity_logo_final.png" alt="ODDity" width="440">
</p>

ODDity is an extension for Visual Studio Code that helps with digital editions in
TEI and other XML formats. It supports you in two tasks: writing and encoding your
documents, and defining the rules that decide how they are presented.

Both tasks build on the [TEI Processing Model](https://tei-c.org/release/doc/tei-p5-doc/en/html/TD.html#TDPM),
a standard way of saying how XML is transformed into a publication format: which
element becomes a heading, a paragraph, a note in the margin or a link. These
presentation rules, together with the encoding rules of your project, are written
in an **ODD** file, the format the TEI defines for this purpose.

Two tools read those rules to produce an edition:
[TEI Publisher](https://tei-publisher.org/), a complete database-backed framework to turn an edition into a dynamic web application, and the [Open Processing Model (opm)](https://github.com/eeditiones/open-processing-model),
which runs on the command line.
ODDity is a companion to both: you write your documents and your ODD in ODDity,
and see straight away how TEI Publisher and opm will present them. If you have
used the web-based editors of TEI Publisher, much of what you find here will feel
familiar.

## What ODDity does for you

- **Write TEI with a safety net.** Mistakes are underlined while you type, and
  suggestions show only the elements and attributes that are allowed at the
  place you are writing, each with a short explanation.
- **See your edition as you work.** A preview beside your text shows the
  document as a web page, as printed pages, as Markdown or as a PDF, and updates
  as you type.
- **Define how your edition is presented.** Write the presentation rules in your
  ODD, in a form-based editor or as XML, and turn the ODD's encoding rules into a
  schema your documents are checked against.

## Getting started

1. Install ODDity from the Visual Studio Code marketplace.
2. Open the folder of your project with **File › Open Folder…**.
3. Open a TEI document. It is checked straight away, and suggestions appear as
   you type.

For the preview, ODDity needs opm. If opm is not installed yet, ODDity offers to
install it for you the first time you open the preview. The PDF output also needs
the free [Typst](https://typst.app/open-source/) program; without it, the other
outputs still work.

## Writing TEI documents

### Checking as you type

Every XML file is checked while you write. If a tag is not closed or a quotation
mark is missing, the place is underlined in red and the **Problems** panel lists
what is wrong.

Where ODDity knows the encoding rules that apply to a document, it also checks
whether the encoding follows them: an element in the wrong place, a required
element that is missing, an attribute value that is not allowed. These rules
come from a *schema*, a file (ending in `.rng`) that describes which elements
may appear where. For TEI documents, ODDity uses the full TEI rules unless your
project has its own (see below).

ODDity understands schemas written in RELAX NG (files ending in `.rng`), the
format TEI and opm produce. Other kinds of schema, such as a DTD or an XML Schema
(`.xsd`), are not read: documents that use one are only checked for
well-formedness, and rules written in Schematron are not checked either.

### Suggestions

Type `<` and ODDity suggests the elements that are allowed at exactly that place,
in the order the rules expect them: inside `<TEI>`, for instance, it offers
`<teiHeader>` first. Each suggestion carries a short description taken from the
TEI Guidelines, such as "line group" for `<lg>`; open the side panel of the
suggestion list (<kbd>Ctrl+Space</kbd>) to read the full explanation.

Inside a start tag, a space brings up the attributes the element may have, and
inside an attribute value the values the rules allow. To ask for suggestions
anywhere else, press <kbd>Ctrl+Space</kbd>.

### Using your project's own rules

Most editions do not use the whole of TEI but a selection, defined in their ODD.
To check your documents against that selection:

1. Right-click your ODD and choose **Compile ODD to RELAX NG**. This writes the
   rules as a `.rng` file next to the ODD. Do it again whenever you change the
   ODD; documents that use the file pick up the change immediately.
2. Right-click one or more documents and choose **Associate with Schema…**. Pick
   the `.rng` file, then decide whether it applies to the selected documents only
   or to every document of the project.

The status bar at the bottom of the window always shows which rules the current
document is checked against. Click it to choose different ones.

<details>
<summary>How ODDity decides which rules apply</summary>

ODDity looks, in this order, for

1. a schema named at the top of the document in an `<?xml-model?>` instruction
   (this is what **Associate with Schema…** adds for selected documents);
2. the schema set for the whole project, under `[editor] schema` in its
   `opm.toml` file (this is what **Associate with Schema…** sets for all
   documents; opm studio uses the same setting);
3. the full TEI rules for TEI documents, and TEI Publisher's rules for writing
   ODDs for `.odd` files. Both come with ODDity.

Other XML files are only checked for well-formedness.

</details>

### Working with elements

These commands are in the editor's right-click menu under **Element**, and have
keyboard shortcuts while you are editing XML:

| Command | macOS | Windows / Linux | What it does |
| --- | --- | --- | --- |
| **Surround with Element…** | <kbd>⌘E</kbd> | <kbd>Ctrl+E</kbd> | Wraps the selected text in an element. You choose from the elements allowed there, and can add attributes after the name, e.g. `persName ref="#goethe"`. |
| **Select Element** | <kbd>⌘⌥E</kbd> | <kbd>Ctrl+Alt+E</kbd> | Selects the element around the cursor. Press again to select the element around that. |
| **Split Element** | <kbd>⌘⇧↩</kbd> | <kbd>Ctrl+Shift+Enter</kbd> | Splits the element at the cursor into two, for instance a paragraph into two paragraphs. |
| **Remove Element Tags** | <kbd>⌘⇧X</kbd> | <kbd>Ctrl+Shift+X</kbd> | Removes the tags of the element around the cursor but keeps its text. |

A few things also happen by themselves:

- When you finish a start tag with `>`, the end tag is added for you.
- When you rename a start tag, its end tag changes with it.
- The **Outline** view (in the Explorer sidebar) lists the parts and chapters of
  a TEI document by their headings, so you can jump to any of them.

## Previewing your edition with opm

[opm](https://github.com/eeditiones/open-processing-model) applies the presentation
rules in your ODD to a document, following the TEI Processing Model just as TEI
Publisher does, and produces web pages, printable pages and other formats. An opm
project is a folder with an `opm.toml` file, which says which ODD, templates and
styles to use.

Open a TEI document of the project and click the preview button in the editor's
title bar (or choose **Open opm Preview to the Side**). The preview appears next
to your text and follows your typing; you do not need to save first. When you
save a change to the ODD, a template or a stylesheet, the preview refreshes.

Choose the kind of output at the top of the preview:

| Output | What you see |
| --- | --- |
| **web** | the document as a web page |
| **print** | the document laid out as printed pages |
| **markdown** | the document as Markdown text |
| **chunk** | the document split into separate pages, as on the published website, with links to move between them. This output is made from the saved file, so it refreshes when you save. |
| **typst** | the document typeset as PDF pages. **Export PDF** saves it as a PDF file. Only offered when Typst is installed. |

**Open output** shows the result as text, for instance the HTML of the web page,
in a separate tab that keeps following the preview.

To see a whole collection, right-click a folder of the project and choose
**Preview Collection with opm**. It shows the pages of every document in that
folder, with an index page. Because this can take a while, it is not redone on
every change: the panel tells you when files have changed, and **Rebuild**
updates it.

If opm or Typst is installed somewhere ODDity does not look, tell it where in the
settings (see below). After installing Typst, choose **Restart opm Preview
Process** so that the typst output appears.

## Defining how your edition is presented: working with ODDs

An ODD holds two kinds of rules for your edition:

- **encoding rules:** which elements and attributes your documents may use, and
  where. ODDity turns these into a schema to check your documents against (see
  [Using your project's own rules](#using-your-projects-own-rules)).
- **presentation rules:** for each element, how it is displayed, written in the
  notation of the TEI Processing Model: as a paragraph, a heading, a note in the
  margin, a link, possibly differently for the web and for print. TEI Publisher
  and opm follow these rules to produce your edition.

An ODD usually builds on another ODD, such as TEI Publisher's `teipublisher.odd`,
and only records what your edition does differently.

ODD files (ending in `.odd`) are checked and completed like other documents, using
TEI Publisher's rules for writing ODDs. On top of that, ODDity helps with the
parts specific to ODDs.

### The graphical ODD editor

The graphical editor shows the processing model as forms, like the ODD editor of
TEI Publisher. On the left you find every element your ODD defines; on the right
the rules for the one you selected: for which output, under which condition, and
with which behaviour it is displayed.

Open it with the button in the editor's title bar, or by right-clicking an ODD
and choosing **Open Graphical Editor**. It opens beside the XML, and both stay in
step: what you change in one appears in the other. Saving changes only what you
edited and leaves the rest of the file exactly as it was.

The forms only let you build what TEI Publisher's rules allow, so you cannot
create an ODD that will be rejected later.

### Adding an element

To customise how an element is displayed, choose **Add &lt;elementSpec&gt;** in the
right-click menu, or **+** in the graphical editor. ODDity lists the elements the
ODD yours builds on already defines: pick one, and its full definition is copied into your ODD, ready
for you to change. Or type the name of a new element to start from an empty
definition.

### Overview of an ODD

For ODDs, the **Outline** view shows what matters instead of the raw XML tree:
your custom behaviours and renditions, the modules you include, and every element
with its display rules, labelled by output, condition and behaviour.

### Updating a running TEI Publisher

If you develop a TEI Publisher application and keep it in sync with an eXist-db
database (using the [eXist-db extension](https://marketplace.visualstudio.com/items?itemName=eXist-db.existdb-vscode)),
**Recompile ODD on server** asks TEI Publisher to compile the ODD again, so that
you see your changes in the application. This needs the `.existdb.json` file of
the eXist-db extension in your project, and the ODD in the `resources/odd` folder.
TEI Publisher compiles the copy in the database, so make sure your changes have
been synced there first.

## Jinks templates

Files ending in `.tpl` are highlighted as [jinks](https://github.com/eeditiones/jinks-templates)
templates, which TEI Publisher uses to generate its pages: HTML with jinks
expressions such as `[[ … ]]` and statements such as `[% … %]`. Files ending in
`.css.tpl` are highlighted as CSS.

## All commands

Open the command palette with <kbd>Ctrl+Shift+P</kbd> (<kbd>⌘⇧P</kbd> on macOS)
and type "ODDity" to see them. Most are also in the right-click menus.

| Command | What it does |
| --- | --- |
| **Surround with Element…** | Wraps the selection in an element allowed there. |
| **Select Element** | Selects the element around the cursor; again for the one around it. |
| **Split Element** | Splits the element at the cursor in two. |
| **Remove Element Tags** | Removes the tags around the cursor, keeping the text. |
| **Associate with Schema…** | Chooses the rules a document, or the whole project, is checked against. |
| **Compile ODD to RELAX NG** | Turns an ODD into rules (a `.rng` file) for checking documents. |
| **Open opm Preview to the Side** | Shows the current document as published by opm. |
| **Preview Collection with opm** | Shows all documents of a folder as published by opm. |
| **Restart opm Preview Process** | Restarts opm, e.g. after installing or updating it or Typst. |
| **Maximize Preview** / **Restore Editor Layout** | Shows the preview on its own, or beside the text again. |
| **Open Graphical Editor** | Opens the form-based editor for an ODD. |
| **Open elementSpec in Graphical Editor** | Opens the graphical editor at the element the cursor is in. |
| **Add &lt;elementSpec&gt;** | Adds an element to your ODD, copied from the ODD it builds on or new. |
| **Go to elementSpec** | Jumps to an element in the graphical editor (<kbd>Ctrl+F</kbd> / <kbd>⌘F</kbd> there). |
| **Recompile ODD on server** | Asks a running TEI Publisher to compile the ODD again. |

## Settings

Open the settings with **File › Preferences › Settings** (**Code › Settings** on
macOS) and search for "ODDity".

| Setting | What it is for |
| --- | --- |
| **Opm: Path** | Where the `opm` program is, if ODDity does not find it. |
| **Opm: Python** | The Python that opm is installed in, for opm in a virtual environment. |
| **Opm: Default Mode** | The output a new preview starts with (web, print, markdown, chunk or typst). |
| **Opm: Typst** | Where the `typst` program is, if ODDity does not find it. |
| **Xml: Auto Close Tags** | Whether end tags are added when you finish a start tag. |
| **Editor Font Size** | The font size of the graphical ODD editor. |

## Requirements

- Visual Studio Code 1.91 or later.
- For the preview: [opm](https://github.com/eeditiones/open-processing-model),
  which ODDity offers to install (it uses `uv tool install open-processing-model`).
- For PDF output: [Typst](https://typst.app/open-source/).

ODDity no longer needs Red Hat's XML extension. If you have it installed, you may
see its messages and suggestions alongside ODDity's; you can disable it for the
workspace if you find that confusing. Keep it if you also work with XML formats
whose schema is a DTD or an XML Schema, which ODDity does not support.

## For developers

```sh
npm install
npm run compile      # or: npm run watch
```

Press <kbd>F5</kbd> to start a development instance of VS Code with the extension.

Checking, suggestions, the outline and the element commands come from
[oddity-language-server](https://github.com/eeditiones/oddity-language-server),
which ODDity shares with opm studio. The build copies the server and its bundled
schemas (`teipublisher_odds.rng`, `tei_all.rng`) into `dist/`; regenerate the
schemas in that package with `npm run schemas`.

`schemas/teipublisher.odd` is the fallback parent ODD that **Add
&lt;elementSpec&gt;** copies from when the ODD a project builds on cannot be found.
It is a copy of `jinks/profiles/base10/resources/odd/teipublisher.odd`; refresh it
from there when the base profile changes.
