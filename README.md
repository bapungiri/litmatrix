# Zotero Annotable (Zotero 7+)

Adds a Zotero tab that lists all highlights/annotations in a table with columns: Annotation, Color, Tags, Comments, Citation Key. Built as a Zotero 7+ WebExtension-style plugin.

## Install (temporary)

1. In Zotero 7, open `Tools → Developer → Debug Add-ons…`.
2. Click `Load Temporary Add-on…` and select the `manifest.json` in this folder.
3. A new toolbar button “Open Annotations Tab” will appear; click it to open the tab.

## Folder layout

- `manifest.json` — WebExtension manifest.
- `background.js` — registers the tab and bridges Zotero APIs to the panel.
- `content/pane.html|css|js` — table UI.

## Features

- Tab shows all annotations with the requested columns.
- Sorting (click headers), filtering (search box), refresh button.
- Clicking a row jumps to the source item in the library.

## Development tips

- Open the add-on console: `Tools → Developer → Run JavaScript` and choose the add-on context to inspect logs.
- If the tab does not appear after loading, click the toolbar button or reload the add-on.

## Building a signed XPI (optional)

Zotero accepts unsigned temporary add-ons. For distribution, zip the contents of this folder with `manifest.json` at the root and rename the zip to `.xpi`.