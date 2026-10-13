# Zotero Annotable

A Zotero 7–9 plugin that shows every annotation in your library in one place, grouped by **color meaning**, **tag**, **paper (citekey)** or **type**, so you can see at a glance what you highlighted across papers.

## Features

- **Annotation Browser** tab (Tools → Annotation Browser), or a separate window (Tools → Annotation Browser (Window)) to keep beside the PDF reader.
- **Papers view** (default; switch with *Papers | Annotations*): one row per paper, built for literature research.
  - Columns are Citekey, Year and Title, with optional Authors, Paper tags and annotation count.
  - Then comes one column per highlight color, titled with its color meaning. Each lists that paper's highlights as bullets, followed by its underlines under the color's *underline meaning*.
  - Filters work as in the annotation table. A paper shows if any of its annotations match, and cells list only the matching annotations.
  - Click a bullet to open the PDF there. Click a color header to sort papers by how many notes of that color they have.
  - Add or remove color columns under *Columns ▾*, and drag headers to reorder. Rows can be grouped by paper tag.
  - *Copy Markdown* produces one literature note per paper, with a `###` heading per color meaning.
- **Notion-style table**: Annotation, Paper tags, Annotation tags, Comment and Citekey columns by default. Use *Columns ▾* to add Page, Title, Authors, Year, Type or Added. Drag a header's right edge to resize a column, and click a header to sort (ascending → descending → back to paper/page order). Rows can show 1 line, 3 lines or the full text.
- **Filter builder**: *+ Add filter* adds a condition row (Color, Paper tags, Annotation tags, Author, Citekey, Year, Type, Annotation text, Comment, Title), and all rows are combined with **And** or **Or**. Each picker shows how many annotations match. Add a field by adding an entry to `FIELDS` in `annotable.js`.
- **Color meanings**: *Color meanings…* lets you name what each highlight color means, and separately what an underline in that color means (e.g. blue = experiment, blue underline = specific methods). These names are used everywhere instead of hex codes.
- **Edit in place** (saved straight back to Zotero):
  - Click a **Comment** cell to edit it. Enter saves, Shift+Enter adds a new line, Esc cancels.
  - Click an **Annotation tags** cell to tick tags on or off, or type a new one.
  - Hover an annotation and use the color button to recolor it.
  - Tick rows in the first column (Shift-click selects a range, the header box selects all shown). The selection bar can then **set color**, **add tag** or **remove tag** for all of them. This is how to fold stray custom colors into your main ones: filter on those colors, select all, set color.
  - Bulk changes ask for confirmation, and every change can be undone from the message that appears.
  - Annotations imported from inside a PDF file (🔒) are read-only in Zotero and are skipped.
- **Quick search** box, and a **library/collection** picker to limit what's shown.
- Optional **grouping** of rows by color, tag, paper or type. Groups can be collapsed.
- **Per-paper view**: right-click items in the library → *Show Annotations*. This adds a Citekey filter.
- **Click a row** to open the PDF at that annotation. Click the citekey to show the paper in the library.
- **Copy Markdown** (all rows shown, one group, or one row) in an Obsidian-friendly format:
  `- ==highlight== — comment ([@citekey, p. 4](zotero://open-pdf/library/items/…?annotation=…)) #tag`
- The view, filters, columns and widths are remembered, and the table updates when you add or edit annotations.

Citation keys come from Zotero's native *Citation Key* field (which Better BibTeX fills in), with fallbacks to Better BibTeX's key manager and `Citation Key:` in Extra.

## Install

1. Build: `pwsh ./build.ps1` → `dist/zotero-annotable-<version>.xpi`
2. Zotero → Tools → Plugins → gear icon → *Install Plugin From File…* → select the `.xpi`.

## Development

The plugin is plain JavaScript, so there's no build step beyond zipping:

- `plugin/bootstrap.js`: registers the menus and opens the tab or window.
- `plugin/content/annotable.{html,js,css}`: the browser UI. It reads annotations directly from the Zotero database.

For live development, skip the XPI. Close Zotero and create a text file named `zotero-annotable@bapungiri` (no extension) in `<Zotero profile>/extensions/`, containing the absolute path to `plugin/`. Restart Zotero; after editing the UI files, close and reopen the Annotations tab.

`legacy/` holds the earlier TypeScript attempt, kept for reference.

## License

AGPL-3.0-or-later
