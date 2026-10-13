## Zotero Annotable (Zotero 7+)

An Annotations tab for Zotero that lists all highlights in a table. Columns: Annotation, Color, Tags, Comments, Citation Key. Clicking a row jumps to the source item.

### Features
- Shows all annotations in a dedicated tab
- Sorting by column (click headers)
- Filter box and refresh button
- Row click selects the parent item in Zotero

### Build & Install
1) Install dependencies: `npm install`
2) Build production XPI: `npm run build`
	- Output: `build/zotero-annotable.xpi`
3) In Zotero 7: Tools → Add-ons → Gear → Install Add-on From File… → select the XPI. Restart if prompted.

### Usage
- After install, Annotable registers an “Annotations” tab and opens it on startup. Use the Refresh button if you add new highlights while the tab is open.

### Development
- Dev build (no XPI packaging): `node scripts/build.mjs`
- Prod build (XPI): `npm run build`
- Source: TypeScript in `src/`, static panel UI in `addon/chrome/content/annotable.*`

### License
AGPL-3.0-or-later
