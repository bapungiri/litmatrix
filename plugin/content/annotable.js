/* global ChromeUtils */
"use strict";

const Zotero = (() => {
  try {
    return ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs").Zotero;
  } catch (e) {
    return window.opener?.Zotero || window.top?.Zotero || window.parent?.Zotero;
  }
})();

const PREF_COLORS = "extensions.zotero-annotable.colorLabels";
const PREF_UI = "extensions.zotero-annotable.ui";

// Zotero's built-in highlight palette, in the order the reader shows it.
const ZOTERO_COLORS = {
  "#ffd400": "Yellow",
  "#ff6666": "Red",
  "#5fb236": "Green",
  "#2ea8e5": "Blue",
  "#a28ae5": "Purple",
  "#e56eee": "Magenta",
  "#f19837": "Orange",
  "#aaaaaa": "Gray",
};
const PALETTE_ORDER = Object.keys(ZOTERO_COLORS);
const TYPE_NAMES = { 1: "Highlight", 2: "Note", 3: "Image", 4: "Ink", 5: "Underline", 6: "Text" };
const UNTAGGED = "\u0000untagged";

const DEFAULT_UI = {
  groupBy: "none",
  rowLines: "3",
  scope: "all",
  collapsed: {},
  columns: ["annotation", "paperTags", "tags", "comment", "citekey"],
  widths: {},
  sort: null, // { col, dir: 1 | -1 }; null = paper, then page
  view: "papers", // "papers" (one row per paper) or "annotations"
  pcols: ["citekey", "year", "title", "color:#f19837", "color:#ffd400", "color:#2ea8e5", "color:#5fb236", "color:#a28ae5", "color:#ff6666", "color:#e56eee", "color:#aaaaaa"],
  pGroupBy: "none",
  psort: null,
  pCollapsedAll: false,
  pToggled: [], // paper IDs whose collapsed state differs from pCollapsedAll
  includeUnannotated: false,
  filter: { conj: "and", conds: [] },
};

const S = {
  all: [], // annotation records, see loadAnnotations()
  colorLabels: {},
  ui: structuredClone(DEFAULT_UI),
  scopeIDs: null, // Set of top-level item IDs in the selected collection, or null
  shown: [],
  unannotated: null, // stand-in records for papers without annotations, when shown
  selected: new Set(), // annotation item IDs ticked in the first column
  lastClicked: null, // for shift-click range selection
  ignoreNotifyUntil: 0, // skip the reload triggered by our own saves
  groups: [],
};

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// "#rrggbb" -> rgba() with the given alpha; used for highlight backgrounds.
function tint(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return `rgba(153,153,153,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Stable pastel per tag, like Notion's select options.
function tagClass(tag) {
  let n = 0;
  for (const ch of tag.replace(/^\*/, "").toLowerCase()) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return `t${n % 9}`;
}

// Zotero stores comments as light HTML (<b>, <i>, <sub>, <sup>). Rebuild only those
// elements from an inert parse, so markup shows as formatting and nothing else runs.
const RICH_TAGS = new Set(["B", "STRONG", "I", "EM", "SUB", "SUP", "U"]);
function richText(html) {
  if (!/[<&]/.test(html)) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const copyNodes = (from, to) => {
    for (const n of from.childNodes) {
      if (n.nodeType === 3) to.append(n.textContent);
      else if (n.nodeType === 1) {
        if (n.tagName === "BR") to.append("\n");
        else if (RICH_TAGS.has(n.tagName)) copyNodes(n, to.appendChild(document.createElement(n.tagName.toLowerCase())));
        else copyNodes(n, to);
      }
    }
  };
  const frag = document.createDocumentFragment();
  copyNodes(doc.body, frag);
  return frag;
}

// Same markup as Markdown, for exports.
function mdText(html) {
  return html
    .replace(/<\/?(b|strong)>/gi, "**")
    .replace(/<\/?(i|em)>/gi, "*")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const plainText = (html) => mdText(html).replace(/\*/g, "");

const swatch = (color, title) => h("span", { class: "swatch", style: `background:${color || "#999"}`, title });

// ---------------------------------------------------------------------------
// prefs

function readJSONPref(key) {
  try {
    const v = Zotero.Prefs.get(key, true);
    return v ? JSON.parse(v) : {};
  } catch (e) {
    return {};
  }
}

function saveUI() {
  Zotero.Prefs.set(PREF_UI, JSON.stringify(S.ui), true);
}

function colorLabel(color) {
  return S.colorLabels[color] || ZOTERO_COLORS[color] || color || "No color";
}

// ---------------------------------------------------------------------------
// data

async function loadAnnotations() {
  const rows = await Zotero.DB.queryAsync(
    `SELECT a.itemID AS id, i.key AS key, i.libraryID AS libraryID,
            a.parentItemID AS attID, a.type AS type, a.text AS text,
            a.comment AS comment, a.color AS color, a.pageLabel AS pageLabel,
            a.sortIndex AS sortIndex, a.isExternal AS isExternal, i.dateAdded AS dateAdded
     FROM itemAnnotations a JOIN items i ON i.itemID = a.itemID
     WHERE a.itemID NOT IN (SELECT itemID FROM deletedItems)`,
  );
  const tagRows = await Zotero.DB.queryAsync(
    `SELECT it.itemID AS id, t.name AS name
     FROM itemTags it JOIN tags t ON t.tagID = it.tagID
     JOIN itemAnnotations a ON a.itemID = it.itemID`,
  );
  // Tags on the paper itself (parent item of the annotated attachment, or a
  // standalone attachment), which most people use more than annotation tags.
  const paperTagRows = await Zotero.DB.queryAsync(
    `SELECT DISTINCT COALESCE(ia.parentItemID, ia.itemID) AS id, t.name AS name
     FROM itemAttachments ia
     JOIN itemTags it ON it.itemID = COALESCE(ia.parentItemID, ia.itemID)
     JOIN tags t ON t.tagID = it.tagID
     WHERE ia.itemID IN (SELECT DISTINCT parentItemID FROM itemAnnotations)`,
  );
  const byID = (tagRowsList) => {
    const m = new Map();
    for (const r of tagRowsList) {
      if (!m.has(r.id)) m.set(r.id, []);
      m.get(r.id).push(r.name);
    }
    for (const v of m.values()) v.sort((a, b) => a.localeCompare(b));
    return m;
  };
  const tagsByID = byID(tagRows);
  const paperTagsByID = byID(paperTagRows);

  const attIDs = [...new Set(rows.map((r) => r.attID))];
  const atts = await Zotero.Items.getAsync(attIDs);
  const topIDs = [...new Set(atts.filter(Boolean).map((a) => a.parentItemID || a.id))];
  const tops = await Zotero.Items.getAsync(topIDs);
  await Zotero.Items.loadDataTypes([...atts, ...tops].filter(Boolean), ["creators", "itemData"]);

  const papers = new Map();
  const attInfo = new Map();
  for (const att of atts) {
    if (!att || att.deleted) continue;
    const top = att.parentItem || att;
    if (top.deleted) continue;
    if (!papers.has(top.id)) papers.set(top.id, { ...paperInfo(top), tags: paperTagsByID.get(top.id) || [] });
    attInfo.set(att.id, { att, paper: papers.get(top.id) });
  }

  const out = [];
  for (const r of rows) {
    const info = attInfo.get(r.attID);
    if (!info) continue;
    out.push({
      id: r.id,
      key: r.key,
      libraryID: r.libraryID,
      type: r.type,
      text: r.text || "",
      comment: r.comment || "",
      color: (r.color || "").toLowerCase(),
      pageLabel: r.pageLabel || "",
      sortIndex: r.sortIndex || "",
      dateAdded: r.dateAdded || "",
      tags: tagsByID.get(r.id) || [],
      // Annotations imported from the PDF file are read-only in Zotero.
      readOnly: !!r.isExternal || !Zotero.Libraries.get(r.libraryID)?.editable,
      attID: r.attID,
      attKey: info.att.key,
      paper: info.paper,
    });
  }
  S.all = out;
}

function paperInfo(top) {
  const field = (name) => {
    try {
      return top.getField(name) || "";
    } catch (e) {
      return "";
    }
  };
  let citekey = field("citationKey");
  if (!citekey) {
    try {
      citekey = Zotero.BetterBibTeX?.KeyManager?.get(top.id)?.citationKey || "";
    } catch (e) {
      /* BBT not ready */
    }
  }
  if (!citekey) citekey = (field("extra").match(/^Citation Key:\s*(\S+)/im) || [])[1] || "";
  const creators = top.isRegularItem() ? top.getCreators() : [];
  const names = creators.map((c) => c.lastName || c.name || "").filter(Boolean);
  const authors =
    names.length > 2 ? `${names[0]} et al.` : names.length === 2 ? `${names[0]} & ${names[1]}` : names[0] || "";
  // "Last, First" for every creator, used by the Author filter.
  const people = creators
    .map((c) => (c.lastName ? (c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName) : c.name || ""))
    .filter(Boolean);
  let year = "";
  try {
    year = (top.getField("date", true, true) || "").slice(0, 4).replace(/^0000$/, "");
  } catch (e) {
    /* no date field */
  }
  const title = (top.getDisplayTitle ? top.getDisplayTitle() : field("title")) || "(untitled)";
  return { id: top.id, key: top.key, libraryID: top.libraryID, citekey: citekey || top.key, title, authors, people, year };
}

// ---------------------------------------------------------------------------
// filter fields. To add a field, add an entry here.
//   kind "multi": get(a) returns the record's values; the user picks from options
//   kind "text":  get(a) returns a string; the user types a substring

const MULTI_OPS = { any: "is any of", none: "is none of" };
const FIELDS = {
  color: {
    label: "Color",
    kind: "multi",
    ops: MULTI_OPS,
    get: (a) => [a.color],
    optionLabel: colorLabel,
    optionSwatch: (v) => v,
    order: (vals, counts) => vals.sort((x, y) => colorRank(x, counts) - colorRank(y, counts)),
  },
  paperTags: {
    label: "Paper tags",
    kind: "multi",
    ops: { any: "has any of", all: "has all of", none: "has none of" },
    get: (a) => a.paper.tags,
  },
  tags: {
    label: "Annotation tags",
    kind: "multi",
    ops: { any: "has any of", all: "has all of", none: "has none of" },
    get: (a) => a.tags,
  },
  author: {
    label: "Author",
    kind: "multi",
    ops: MULTI_OPS,
    get: (a) => a.paper.people,
  },
  citekey: {
    label: "Citekey",
    kind: "multi",
    ops: MULTI_OPS,
    get: (a) => [a.paper.citekey],
  },
  year: {
    label: "Year",
    kind: "multi",
    ops: MULTI_OPS,
    get: (a) => (a.paper.year ? [a.paper.year] : []),
    order: (vals) => vals.sort().reverse(),
  },
  type: {
    label: "Type",
    kind: "multi",
    ops: MULTI_OPS,
    get: (a) => [String(a.type)],
    optionLabel: (v) => TYPE_NAMES[v] || v,
  },
  text: {
    label: "Annotation text",
    kind: "text",
    ops: { contains: "contains", not: "does not contain", empty: "is empty", notempty: "is not empty" },
    get: (a) => a.text,
  },
  comment: {
    label: "Comment",
    kind: "text",
    ops: { contains: "contains", not: "does not contain", empty: "is empty", notempty: "is not empty" },
    get: (a) => plainText(a.comment),
  },
  title: {
    label: "Title",
    kind: "text",
    ops: { contains: "contains", not: "does not contain" },
    get: (a) => a.paper.title,
  },
};

function condActive(c) {
  const f = FIELDS[c.field];
  if (!f) return false;
  if (f.kind === "multi") return (c.values || []).length > 0;
  return c.op === "empty" || c.op === "notempty" || !!(c.text || "").trim();
}

function evalCond(c, a) {
  const f = FIELDS[c.field];
  if (f.kind === "multi") {
    const vals = f.get(a);
    const sel = c.values;
    if (c.op === "all") return sel.every((v) => vals.includes(v));
    const hit = vals.some((v) => sel.includes(v));
    return c.op === "none" ? !hit : hit;
  }
  const s = (f.get(a) || "").toLowerCase();
  const t = (c.text || "").trim().toLowerCase();
  if (c.op === "empty") return !s;
  if (c.op === "notempty") return !!s;
  return c.op === "not" ? !s.includes(t) : s.includes(t);
}

function passFilter(a, conds) {
  if (!conds.length) return true;
  return S.ui.filter.conj === "or" ? conds.some((c) => evalCond(c, a)) : conds.every((c) => evalCond(c, a));
}

// ---------------------------------------------------------------------------
// scope (library / collection) and quick search

function buildScopeSelect() {
  const options = [{ value: "all", label: "All libraries" }];
  for (const lib of Zotero.Libraries.getAll()) {
    if (!["user", "group"].includes(lib.libraryType)) continue;
    options.push({ value: `lib:${lib.libraryID}`, label: lib.name });
    for (const col of Zotero.Collections.getByLibrary(lib.libraryID, true)) {
      options.push({ value: `col:${col.id}`, label: col.name, indent: (col.level || 0) + 1 });
    }
  }
  if (!options.some((o) => o.value === S.ui.scope)) S.ui.scope = "all";
  scopeDropdown.setOptions(options, S.ui.scope);
  computeScopeIDs();
}

function computeScopeIDs() {
  S.scopeIDs = null;
  const [kind, id] = S.ui.scope.split(":");
  if (kind !== "col") return;
  const col = Zotero.Collections.get(Number(id));
  if (!col) return;
  const ids = new Set(col.getChildItems(true));
  for (const sub of Zotero.Collections.getByParent(col.id, true)) {
    for (const i of sub.getChildItems(true)) ids.add(i);
  }
  S.scopeIDs = ids;
}

function searchText(a) {
  if (!a._search) {
    a._search = [a.text, plainText(a.comment), a.paper.citekey, a.paper.title, a.paper.authors, a.paper.year, a.tags.join(" "), a.paper.tags.join(" "), colorLabel(a.color)]
      .join("\n")
      .toLowerCase();
  }
  return a._search;
}

// Records in scope and matching the quick search; the filter builder narrows these further.
function baseRecords(list = S.all) {
  const terms = $("#search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [kind, id] = S.ui.scope.split(":");
  return list.filter((a) => {
    if (kind === "lib" && a.libraryID !== Number(id)) return false;
    if (S.scopeIDs && !S.scopeIDs.has(a.paper.id)) return false;
    if (terms.length) {
      const s = searchText(a);
      if (!terms.every((t) => s.includes(t))) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// columns

function colorRank(c, counts) {
  const i = PALETTE_ORDER.indexOf(c);
  // Palette colors first, then custom colors by how often they are used.
  return i >= 0 ? i : 100 + 1 / (1 + (counts?.get(c) || 0));
}

const defaultOrder = (a, b) =>
  a.paper.citekey.localeCompare(b.paper.citekey) || a.attID - b.attID || a.sortIndex.localeCompare(b.sortIndex);

const COLUMNS = {
  annotation: { label: "Annotation", width: 520, sortKey: (a) => colorRank(a.color), render: renderAnnotationCell },
  paperTags: {
    label: "Paper tags",
    width: 190,
    sortKey: (a) => a.paper.tags.join(", ").toLowerCase() || "￿",
    render: (a) => a.paper.tags.map((t) => h("span", { class: `pill ${tagClass(t)}` }, t)),
  },
  tags: {
    label: "Annotation tags",
    width: 150,
    sortKey: (a) => a.tags.join(", ").toLowerCase() || "￿",
    render: (a) => a.tags.map((t) => h("span", { class: `pill ${tagClass(t)}` }, t)),
  },
  comment: { label: "Comment", width: 300, sortKey: (a) => a.comment.toLowerCase() || "￿", render: (a) => richText(a.comment) },
  citekey: {
    label: "Citekey",
    width: 180,
    sortKey: (a) => a.paper.citekey.toLowerCase(),
    render: (a) => [
      h(
        "span",
        {
          class: "cite",
          title: "Show this paper in the library",
          onclick: (e) => {
            e.stopPropagation();
            selectInLibrary(a.paper.id);
          },
        },
        a.paper.citekey,
      ),
      a.pageLabel ? h("span", { class: "muted" }, ` p. ${a.pageLabel}`) : null,
    ],
  },
  page: { label: "Page", width: 60, sortKey: (a) => parseInt(a.pageLabel, 10) || 0, render: (a) => a.pageLabel },
  title: { label: "Title", width: 280, sortKey: (a) => a.paper.title.toLowerCase(), render: (a) => a.paper.title },
  authors: { label: "Authors", width: 160, sortKey: (a) => a.paper.authors.toLowerCase(), render: (a) => a.paper.authors },
  year: { label: "Year", width: 60, sortKey: (a) => a.paper.year || "0", render: (a) => a.paper.year },
  type: { label: "Type", width: 90, sortKey: (a) => a.type, render: (a) => TYPE_NAMES[a.type] || "" },
  added: { label: "Added", width: 100, sortKey: (a) => a.dateAdded, render: (a) => a.dateAdded.slice(0, 10) },
};

function renderAnnotationCell(a) {
  let body;
  if (a.type === 3) {
    const path = Zotero.Annotations.getCacheImagePath({ libraryID: a.libraryID, key: a.key });
    body = h("img", {
      src: Zotero.File.pathToFileURI(path),
      alt: "image annotation",
      onerror: (e) => e.target.replaceWith("[image — open the PDF once to generate the preview]"),
    });
  } else if (a.type === 4) {
    body = h("span", { class: "muted" }, "[ink drawing]");
  } else if (a.text) {
    body = h("mark", { style: `background:${tint(a.color, 0.38)}` }, a.text);
  } else {
    body = h("span", { class: "muted" }, `[${TYPE_NAMES[a.type] || "annotation"}]`);
  }
  const actions = h(
    "span",
    { class: "row-actions" },
    a.readOnly
      ? h("span", { class: "lock", title: "Imported from the PDF file, so Zotero won't let it be edited" }, "🔒")
      : h(
          "button",
          {
            title: "Change color",
            onclick: (e) => {
              e.stopPropagation();
              openColorPicker(e.currentTarget, [a]);
            },
          },
          swatch(a.color),
          " ▾",
        ),
    h(
      "button",
      {
        title: "Copy as Markdown",
        onclick: (e) => {
          e.stopPropagation();
          copy(annotationMarkdown(a), "Copied");
        },
      },
      "Copy",
    ),
  );
  return [actions, body];
}

function visibleColumns() {
  const cols = S.ui.columns.filter((c) => COLUMNS[c]);
  return cols.length ? cols : ["annotation"];
}

// ---------------------------------------------------------------------------
// filter bar

function renderFilterBar() {
  const bar = $("#filterBar");
  bar.textContent = "";
  const { filter } = S.ui;
  filter.conds.forEach((c, i) => bar.append(renderCond(c, i)));
  bar.append(
    h(
      "div",
      { class: "filter-actions" },
      h("button", { class: "ghost", onclick: addCondition }, "+ Add filter"),
      filter.conds.length
        ? h(
            "button",
            {
              class: "ghost",
              onclick: () => {
                filter.conds = [];
                filtersChanged(true);
              },
            },
            "Clear filters",
          )
        : null,
    ),
  );
}

function renderCond(c, i) {
  const f = FIELDS[c.field];
  const { filter } = S.ui;
  let conj;
  if (i === 0) conj = h("span", { class: "conj" }, "Where");
  else if (i === 1) {
    conj = dropdown({
      cls: "conj",
      options: [
        { value: "and", label: "And" },
        { value: "or", label: "Or" },
      ],
      value: filter.conj,
      onChange: (v) => {
        filter.conj = v;
        filtersChanged(true);
      },
    });
  } else conj = h("span", { class: "conj" }, filter.conj === "or" ? "Or" : "And");

  const fieldSel = dropdown({
    options: Object.entries(FIELDS).map(([k, v]) => ({ value: k, label: v.label })),
    value: c.field,
    onChange: (v) => {
      Object.assign(c, { field: v, op: Object.keys(FIELDS[v].ops)[0], values: [], text: "" });
      filtersChanged(true);
    },
  });

  const opSel = dropdown({
    options: Object.entries(f.ops).map(([k, v]) => ({ value: k, label: v })),
    value: c.op,
    onChange: (v) => {
      c.op = v;
      filtersChanged(true);
    },
  });

  let value = null;
  if (f.kind === "multi") {
    value = h("button", { class: "value" });
    fillValueButton(value, c);
    value.addEventListener("click", () => openOptionsPopover(value, c));
  } else if (c.op !== "empty" && c.op !== "notempty") {
    let t;
    value = h("input", {
      class: "value",
      type: "text",
      value: c.text || "",
      placeholder: "Type text…",
      oninput: (e) => {
        c.text = e.target.value;
        clearTimeout(t);
        t = setTimeout(() => filtersChanged(false), 200);
      },
    });
  }

  const remove = h(
    "button",
    {
      class: "remove",
      title: "Remove this filter",
      onclick: () => {
        filter.conds.splice(i, 1);
        filtersChanged(true);
      },
    },
    "✕",
  );
  return h("div", { class: "cond" }, conj, fieldSel, opSel, value, remove);
}

function fillValueButton(btn, c) {
  const f = FIELDS[c.field];
  btn.textContent = "";
  if (!c.values.length) {
    btn.append(h("span", { class: "placeholder" }, "Select…"));
    return;
  }
  for (const v of c.values) {
    btn.append(h("span", { class: `pill ${c.field === "tags" || c.field === "paperTags" ? tagClass(v) : ""}` }, f.optionSwatch ? swatch(f.optionSwatch(v)) : null, f.optionLabel ? f.optionLabel(v) : v));
  }
}

function addCondition() {
  const used = new Set(S.ui.filter.conds.map((c) => c.field));
  const field = ["color", "paperTags", "author", "tags"].find((k) => !used.has(k)) || "tags";
  S.ui.filter.conds.push({ field, op: Object.keys(FIELDS[field].ops)[0], values: [], text: "" });
  filtersChanged(true);
  // Open the value picker of the new condition straight away.
  const rows = document.querySelectorAll("#filterBar .cond");
  rows[rows.length - 1]?.querySelector("button.value")?.click();
}

function filtersChanged(rebuildBar) {
  if (rebuildBar) renderFilterBar();
  saveUI();
  render();
}

// ---------------------------------------------------------------------------
// popover (option picker and column menu)

let popoverCleanup = null;

// Single-choice dropdown. Native <select> popups don't render in Zotero's chrome
// pages (the options get painted inline), so this uses the popover instead.
function dropdown({ options, value, onChange, cls = "" }) {
  const btn = h("button", { class: `dd ${cls}` });
  const set = (v) => {
    btn.dataset.value = v;
    const o = options.find((x) => x.value === v) || options[0];
    btn.textContent = "";
    btn.append(h("span", { class: "dd-label" }, o ? o.label : ""), h("span", { class: "dd-caret" }, "▾"));
  };
  btn.setOptions = (opts, v) => {
    options = opts;
    set(v);
  };
  set(value);
  btn.addEventListener("click", () =>
    openPopover(btn, (pop) => {
      const list = h("div", { class: "opts" });
      const search = options.length > 12 ? h("input", { type: "search", placeholder: "Search…" }) : null;
      const draw = () => {
        const q = (search?.value || "").trim().toLowerCase();
        list.textContent = "";
        for (const o of options) {
          if (q && !o.label.toLowerCase().includes(q)) continue;
          list.append(
            h(
              "div",
              {
                class: `opt${o.value === btn.dataset.value ? " sel" : ""}`,
                style: o.indent && !q ? `padding-left:${8 + o.indent * 14}px` : null,
                onclick: () => {
                  closePopover();
                  if (o.value === btn.dataset.value) return;
                  set(o.value);
                  onChange(o.value);
                },
              },
              h("span", { class: "lbl" }, o.label),
            ),
          );
        }
      };
      search?.addEventListener("input", draw);
      draw();
      if (search) pop.append(search);
      pop.append(list);
    }),
  );
  return btn;
}

function openPopover(anchor, build) {
  closePopover();
  const pop = $("#popover");
  pop.textContent = "";
  build(pop);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8)}px`;
  const onDown = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const onKey = (e) => e.key === "Escape" && closePopover();
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  popoverCleanup = () => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
  pop.querySelector("input")?.focus();
}

function closePopover() {
  $("#popover").hidden = true;
  popoverCleanup?.();
  popoverCleanup = null;
}

function openOptionsPopover(anchor, c) {
  const f = FIELDS[c.field];
  // Counts come from the records in scope that pass the *other* filters, like Notion's facets.
  const others = S.ui.filter.conds.filter((x) => x !== c && condActive(x));
  const counts = new Map();
  for (const a of baseRecords()) {
    if (!passFilter(a, others)) continue;
    for (const v of f.get(a)) counts.set(v, (counts.get(v) || 0) + 1);
  }
  for (const v of c.values) if (!counts.has(v)) counts.set(v, 0);
  let values = [...counts.keys()].filter((v) => v !== "");
  values = f.order ? f.order(values, counts) : values.sort((x, y) => counts.get(y) - counts.get(x) || x.localeCompare(y));
  const LIMIT = 300;

  openPopover(anchor, (pop) => {
    const list = h("div", { class: "opts" });
    const search = h("input", { type: "search", placeholder: `Search ${f.label.toLowerCase()}…` });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const label = (v) => (f.optionLabel ? f.optionLabel(v) : v);
      let vis = values.filter((v) => !q || label(v).toLowerCase().includes(q) || v.toLowerCase().includes(q));
      vis = [...vis.filter((v) => c.values.includes(v)), ...vis.filter((v) => !c.values.includes(v))];
      list.textContent = "";
      for (const v of vis.slice(0, LIMIT)) {
        const cb = h("input", { type: "checkbox", checked: c.values.includes(v) });
        list.append(
          h(
            "label",
            { class: "opt", title: v },
            cb,
            f.optionSwatch ? swatch(f.optionSwatch(v)) : null,
            h("span", { class: "lbl" }, label(v)),
            h("span", { class: "n" }, counts.get(v)),
          ),
        );
        cb.addEventListener("change", () => {
          c.values = cb.checked ? [...c.values, v] : c.values.filter((x) => x !== v);
          fillValueButton(anchor, c);
          filtersChanged(false);
        });
      }
      if (vis.length > LIMIT) list.append(h("div", { class: "more" }, `${vis.length - LIMIT} more — type to narrow`));
      if (!vis.length) list.append(h("div", { class: "more" }, "No matches"));
    };
    search.addEventListener("input", draw);
    draw();
    pop.append(search, list);
  });
}

function openColumnsPopover(anchor) {
  openPopover(anchor, (pop) => {
    const list = h("div", { class: "opts" });
    for (const [k, col] of Object.entries(COLUMNS)) {
      const cb = h("input", { type: "checkbox", checked: S.ui.columns.includes(k) });
      cb.addEventListener("change", () => {
        if (cb.checked) {
          if (!S.ui.columns.includes(k)) S.ui.columns.push(k);
        } else S.ui.columns = S.ui.columns.filter((x) => x !== k);
        saveUI();
        render();
      });
      list.append(h("label", { class: "opt" }, cb, h("span", { class: "lbl" }, col.label)));
    }
    pop.append(list);
  });
}

// ---------------------------------------------------------------------------
// grouping

function makeGroups(list) {
  const groupBy = S.ui.groupBy;
  if (groupBy === "none") return [{ key: "all", items: list }];
  const groups = new Map();
  const add = (key, a, meta) => {
    if (!groups.has(key)) groups.set(key, { key, items: [], ...meta() });
    groups.get(key).items.push(a);
  };
  for (const a of list) {
    if (groupBy === "color") {
      add(a.color, a, () => ({ label: colorLabel(a.color), sub: S.colorLabels[a.color] ? ZOTERO_COLORS[a.color] || a.color : "", color: a.color }));
    } else if (groupBy === "tag") {
      if (!a.tags.length) add(UNTAGGED, a, () => ({ label: "Untagged" }));
      for (const t of a.tags) add(t, a, () => ({ label: t }));
    } else if (groupBy === "paperTag") {
      if (!a.paper.tags.length) add(UNTAGGED, a, () => ({ label: "Untagged" }));
      for (const t of a.paper.tags) add(t, a, () => ({ label: t }));
    } else if (groupBy === "paper") {
      const p = a.paper;
      add(String(p.id), a, () => ({
        label: p.citekey,
        sub: [p.authors, p.year && `(${p.year})`, "—", p.title].filter(Boolean).join(" "),
        paper: p,
      }));
    } else if (groupBy === "type") {
      add(String(a.type), a, () => ({ label: TYPE_NAMES[a.type] || "Other" }));
    }
  }
  const out = [...groups.values()];
  if (groupBy === "color") {
    const counts = new Map(out.map((g) => [g.key, g.items.length]));
    out.sort((a, b) => colorRank(a.key, counts) - colorRank(b.key, counts));
  } else if (groupBy === "tag" || groupBy === "paperTag") {
    out.sort((a, b) => (a.key === UNTAGGED) - (b.key === UNTAGGED) || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  } else if (groupBy === "paper") {
    out.sort((a, b) => a.label.localeCompare(b.label));
  } else {
    out.sort((a, b) => Number(a.key) - Number(b.key));
  }
  return out;
}

// ---------------------------------------------------------------------------
// rendering

function sortRecords(list) {
  const s = S.ui.sort;
  const col = s && COLUMNS[s.col];
  if (!col) return list.sort(defaultOrder);
  return list.sort((a, b) => {
    const x = col.sortKey(a);
    const y = col.sortKey(b);
    const r = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return r * s.dir || defaultOrder(a, b);
  });
}

function render() {
  const active = S.ui.filter.conds.filter(condActive);
  const shown = sortRecords(baseRecords().filter((a) => passFilter(a, active)));
  S.shown = shown;
  document.body.dataset.lines = S.ui.rowLines;
  document.body.dataset.view = S.ui.view;
  syncViewControls();

  const results = $("#results");
  const scroll = results.scrollTop;
  if (S.ui.view === "papers") {
    $("#selBar").hidden = true;
    renderPapers(shown);
  } else renderAnnotations(shown);
  results.scrollTop = scroll;
}

function renderAnnotations(shown) {
  S.groups = makeGroups(shown);
  const nPapers = new Set(shown.map((a) => a.paper.id)).size;
  $("#status").textContent = `${shown.length} of ${S.all.length} annotations · ${nPapers} paper${nPapers === 1 ? "" : "s"}`;
  renderSelectionBar();

  const cols = visibleColumns();
  renderHead(cols);

  const tbody = $("#grid tbody");
  tbody.textContent = "";
  $("#empty").hidden = shown.length > 0;
  $("#empty").textContent = S.all.length ? "No annotations match the current filters." : "No annotations found.";

  const collapsed = new Set(S.ui.collapsed[S.ui.groupBy] || []);
  const frag = document.createDocumentFragment();
  for (const g of S.groups) {
    const isCollapsed = collapsed.has(g.key);
    if (S.ui.groupBy !== "none") frag.append(renderGroupRow(g, cols.length + 1, isCollapsed));
    // Rows of collapsed groups are built when the group is first expanded.
    if (!isCollapsed) for (const a of g.items) frag.append(renderRow(a, cols));
  }
  tbody.append(frag);
}

function renderHead(cols) {
  const colgroup = $("#grid colgroup");
  colgroup.textContent = "";
  colgroup.append(h("col", { style: "width:34px" }));
  let total = 34;
  for (const k of cols) {
    const w = S.ui.widths[k] || COLUMNS[k].width;
    total += w;
    colgroup.append(h("col", { "data-col": k, style: `width:${w}px` }));
  }
  $("#grid").style.width = `${total}px`;

  const tr = h("tr");
  const nSel = S.shown.filter((a) => S.selected.has(a.id)).length;
  const allCb = h("input", {
    type: "checkbox",
    title: "Select all shown",
    checked: S.shown.length > 0 && nSel === S.shown.length,
    onchange: (e) => {
      for (const a of S.shown) e.target.checked ? S.selected.add(a.id) : S.selected.delete(a.id);
      render();
    },
  });
  allCb.indeterminate = nSel > 0 && nSel < S.shown.length;
  tr.append(h("th", { class: "c-sel" }, allCb));
  for (const k of cols) {
    const col = COLUMNS[k];
    const s = S.ui.sort;
    const label = h(
      "span",
      {
        class: "th-label",
        title: k === "annotation" ? "Sort by color" : `Sort by ${col.label.toLowerCase()}`,
        onclick: () => {
          // asc -> desc -> default (paper, page)
          if (!s || s.col !== k) S.ui.sort = { col: k, dir: 1 };
          else if (s.dir === 1) S.ui.sort = { col: k, dir: -1 };
          else S.ui.sort = null;
          saveUI();
          render();
        },
      },
      col.label,
      s && s.col === k ? h("span", { class: "sort" }, s.dir === 1 ? " ▲" : " ▼") : null,
    );
    const inner = h("div", { class: "th-inner" }, label);
    const th = h("th", {}, inner, h("span", { class: "resizer", onmousedown: (e) => startResize(e, k) }));
    makeDraggable(th, k, "columns");
    tr.append(th);
  }
  const thead = $("#grid thead");
  thead.textContent = "";
  thead.append(tr);
}

function startResize(e, k) {
  e.preventDefault();
  e.stopPropagation();
  const col = document.querySelector(`#grid col[data-col="${k}"]`);
  const startX = e.clientX;
  const startW = S.ui.widths[k] || (COLUMNS[k] || paperColDef(k)).width;
  const table = $("#grid");
  const startTotal = table.offsetWidth;
  const move = (ev) => {
    const w = Math.max(50, startW + ev.clientX - startX);
    col.style.width = `${w}px`;
    table.style.width = `${startTotal + w - startW}px`;
    S.ui.widths[k] = w;
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    saveUI();
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

function renderRow(a, cols) {
  const tr = h("tr", {
    class: `row${S.selected.has(a.id) ? " selected" : ""}`,
    "data-id": a.id,
    onclick: () => {
      // Don't jump to the PDF when the user is selecting text to copy.
      if (!window.getSelection().isCollapsed) return;
      openInReader(a);
    },
  });
  const cb = h("input", { type: "checkbox", checked: S.selected.has(a.id) });
  tr.append(
    h(
      "td",
      {
        class: "c-sel",
        onclick: (e) => {
          e.stopPropagation();
          if (e.target !== cb) cb.checked = !cb.checked;
          toggleSelect(a, cb.checked, e.shiftKey);
        },
      },
      cb,
    ),
  );
  for (const k of cols) {
    const td = h("td", { class: `c-${k}` }, h("div", { class: "cell" }, COLUMNS[k].render(a)));
    if (k === "annotation") td.style.setProperty("--c", a.color || "#999");
    if ((k === "comment" || k === "tags") && !a.readOnly) {
      td.classList.add("editable");
      td.title = k === "comment" ? "Click to edit the comment" : "Click to edit the tags";
      td.addEventListener("click", (e) => {
        e.stopPropagation();
        if (k === "comment") editComment(td, a);
        else openTagEditor(td, a);
      });
    }
    tr.append(td);
  }
  return tr;
}

function renderGroupRow(g, ncols, isCollapsed) {
  const td = h(
    "td",
    { colspan: ncols },
    h(
      "div",
      { class: "g-inner" },
      h("span", { class: "caret" }, isCollapsed ? "▸" : "▾"),
      g.color !== undefined ? swatch(g.color) : null,
      h("span", { class: "g-label" }, g.label),
      g.sub ? h("span", { class: "sub", title: g.sub }, g.sub) : null,
      h("span", { class: "n" }, g.items.length),
      h(
        "button",
        {
          title: "Copy this group as Markdown",
          onclick: (e) => {
            e.stopPropagation();
            copy(groupMarkdown(g, "##"), `Copied ${g.items.length} annotations`);
          },
        },
        "Copy",
      ),
    ),
  );
  return h(
    "tr",
    {
      class: "group",
      onclick: () => {
        const set = new Set(S.ui.collapsed[S.ui.groupBy] || []);
        set.has(g.key) ? set.delete(g.key) : set.add(g.key);
        S.ui.collapsed[S.ui.groupBy] = [...set];
        saveUI();
        render();
      },
    },
    td,
  );
}

// ---------------------------------------------------------------------------
// papers view: one row per paper, one column per highlight color (and per underline color)

// Default color columns, in reading order: questions, results, methods, discussion, ...
const DEFAULT_COLOR_COLUMNS = ["#f19837", "#ffd400", "#2ea8e5", "#5fb236", "#a28ae5", "#ff6666", "#e56eee", "#aaaaaa"];
const UNDERLINE = 5;

const underlineLabel = (c) => S.colorLabels[`${c}|underline`] || `${colorLabel(c)} (underline)`;
const isColorCol = (k) => k.startsWith("color:") || k.startsWith("underline:");

const PAPER_COLUMNS = {
  citekey: {
    label: "Citekey",
    width: 160,
    sortKey: (R) => R.paper.citekey.toLowerCase(),
    render: (R) =>
      h(
        "span",
        {
          class: "cite",
          title: "Show this paper in the library",
          onclick: (e) => {
            e.stopPropagation();
            selectInLibrary(R.paper.id);
          },
        },
        R.paper.citekey,
      ),
  },
  year: { label: "Year", width: 62, sortKey: (R) => R.paper.year || "0", render: (R) => R.paper.year },
  title: { label: "Title", width: 260, sortKey: (R) => R.paper.title.toLowerCase(), render: (R) => R.paper.title },
  authors: { label: "Authors", width: 150, sortKey: (R) => R.paper.authors.toLowerCase(), render: (R) => R.paper.authors },
  paperTags: {
    label: "Paper tags",
    width: 170,
    sortKey: (R) => R.paper.tags.join(", ").toLowerCase() || "￿",
    render: (R) => R.paper.tags.map((t) => h("span", { class: `pill ${tagClass(t)}` }, t)),
  },
  count: { label: "Annotations", width: 90, sortKey: (R) => R.anns.length, render: (R) => R.anns.length },
};

const cellList = (R, c, underline) => (R.byColor.get(c) || []).filter((a) => (a.type === UNDERLINE) === underline);

function colorColumn(c, underline) {
  return {
    label: underline ? underlineLabel(c) : colorLabel(c),
    color: c,
    underline,
    width: 300,
    sortKey: (R) => cellList(R, c, underline).length,
    render: (R) => renderColorCell(R, c, underline),
  };
}

function paperColDef(k) {
  if (k.startsWith("color:")) return colorColumn(k.slice(6), false);
  if (k.startsWith("underline:")) return colorColumn(k.slice(10), true);
  return PAPER_COLUMNS[k];
}

function visiblePaperColumns() {
  const cols = S.ui.pcols.filter((k) => isColorCol(k) || PAPER_COLUMNS[k]);
  return cols.length ? cols : ["citekey"];
}

// Once, for settings from before underlines had their own columns: put an underline
// column next to each color column for which there are underline annotations.
function addUnderlineColumns() {
  if (S.ui.underlineColsAdded || !S.all.length) return;
  const underlined = new Set(S.all.filter((a) => a.type === UNDERLINE).map((a) => a.color));
  const out = [];
  for (const k of S.ui.pcols) {
    out.push(k);
    if (k.startsWith("color:") && underlined.has(k.slice(6)) && !S.ui.pcols.includes(`underline:${k.slice(6)}`)) {
      out.push(`underline:${k.slice(6)}`);
    }
  }
  S.ui.pcols = out;
  S.ui.underlineColsAdded = true;
  saveUI();
}

// --- papers without annotations (optional)

// All regular top-level items in user/group libraries, as paper info objects.
// Loaded only when "Show unannotated" is on.
async function loadAllPapers() {
  const notChild = `itemID NOT IN (SELECT itemID FROM itemAttachments)
     AND itemID NOT IN (SELECT itemID FROM itemNotes)
     AND itemID NOT IN (SELECT itemID FROM itemAnnotations)`;
  const ids = await Zotero.DB.columnQueryAsync(
    `SELECT itemID FROM items WHERE itemID NOT IN (SELECT itemID FROM deletedItems) AND ${notChild}`,
  );
  const tagRows = await Zotero.DB.queryAsync(
    `SELECT it.itemID AS id, t.name AS name FROM itemTags it JOIN tags t ON t.tagID = it.tagID
     WHERE it.itemID IN (SELECT itemID FROM items WHERE ${notChild})`,
  );
  const tags = new Map();
  for (const r of tagRows) {
    if (!tags.has(r.id)) tags.set(r.id, []);
    tags.get(r.id).push(r.name);
  }
  const libs = new Set(
    Zotero.Libraries.getAll()
      .filter((l) => ["user", "group"].includes(l.libraryType))
      .map((l) => l.libraryID),
  );
  const items = (await Zotero.Items.getAsync(ids)).filter((it) => it && libs.has(it.libraryID) && it.isRegularItem());
  await Zotero.Items.loadDataTypes(items, ["creators", "itemData"]);
  const annotated = new Set(S.all.map((a) => a.paper.id));
  S.unannotated = items
    .filter((it) => !annotated.has(it.id))
    .map((it) => {
      const paper = { ...paperInfo(it), tags: (tags.get(it.id) || []).sort((a, b) => a.localeCompare(b)) };
      // A stand-in record so the same scope/search/filter code applies.
      return { id: -it.id, paper, libraryID: it.libraryID, type: 0, text: "", comment: "", color: "", tags: [], pageLabel: "", dateAdded: "", placeholder: true };
    });
}

// --- rows

function buildPaperRows(annotations, placeholders) {
  const rows = new Map();
  const rowFor = (paper) => {
    let R = rows.get(paper.id);
    if (!R) rows.set(paper.id, (R = { paper, anns: [], byColor: new Map() }));
    return R;
  };
  for (const a of annotations) {
    const R = rowFor(a.paper);
    R.anns.push(a);
    if (!R.byColor.has(a.color)) R.byColor.set(a.color, []);
    R.byColor.get(a.color).push(a);
  }
  for (const a of placeholders) rowFor(a.paper);
  const out = [...rows.values()];
  for (const R of out) for (const list of R.byColor.values()) list.sort((x, y) => x.attID - y.attID || x.sortIndex.localeCompare(y.sortIndex));
  const s = S.ui.psort;
  const col = s && paperColDef(s.col);
  const byKey = (R) => R.paper.citekey.toLowerCase();
  out.sort((A, B) => {
    if (col) {
      const x = col.sortKey(A);
      const y = col.sortKey(B);
      const r = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      if (r) return r * s.dir;
    }
    return byKey(A).localeCompare(byKey(B));
  });
  return out;
}

function bulletText(a) {
  if (a.text) return a.text;
  if (a.type === 3) return "[image]";
  if (a.type === 4) return "[ink drawing]";
  return a.comment ? richText(a.comment) : `[${TYPE_NAMES[a.type] || "annotation"}]`;
}

function renderBullet(a, underline) {
  const showComment = a.comment && (a.text || a.type === 3 || a.type === 4);
  return h(
    "li",
    {
      title: `p. ${a.pageLabel || "?"} — click to open in the PDF`,
      onclick: (e) => {
        e.stopPropagation();
        if (!window.getSelection().isCollapsed) return;
        openInReader(a);
      },
    },
    h(
      "span",
      { class: `t${underline ? " u" : ""}`, style: underline ? `text-decoration-color:${a.color}` : null },
      bulletText(a),
      a.pageLabel ? h("span", { class: "pg" }, ` p. ${a.pageLabel}`) : null,
    ),
    showComment ? h("div", { class: "cm" }, richText(a.comment)) : null,
  );
}

function renderColorCell(R, c, underline) {
  const list = cellList(R, c, underline);
  if (!list.length) return null;
  if (isPaperCollapsed(R)) return h("span", { class: "cnt", style: `--c:${c}` }, list.length);
  return h("ul", { class: "bullets", style: `--c:${c}` }, list.map((a) => renderBullet(a, underline)));
}

// --- collapsing

function isPaperCollapsed(R) {
  if (!R.anns.length) return false;
  return !!S.ui.pCollapsedAll !== S.ui.pToggled.includes(R.paper.id);
}

function togglePaper(R) {
  const id = R.paper.id;
  S.ui.pToggled = S.ui.pToggled.includes(id) ? S.ui.pToggled.filter((x) => x !== id) : [...S.ui.pToggled, id];
  saveUI();
  render();
}

function anyPaperExpanded() {
  return (S.paperRows || []).some((R) => R.anns.length && !isPaperCollapsed(R));
}

function setAllPapersCollapsed(collapsed) {
  S.ui.pCollapsedAll = collapsed;
  S.ui.pToggled = [];
  saveUI();
  render();
}

// --- rendering

function renderPapers(shown) {
  addUnderlineColumns();
  let placeholders = [];
  if (S.ui.includeUnannotated && S.unannotated) {
    const active = S.ui.filter.conds.filter(condActive);
    placeholders = baseRecords(S.unannotated).filter((a) => passFilter(a, active));
  }
  const rows = buildPaperRows(shown, placeholders);
  S.paperRows = rows;
  S.paperGroups = makePaperGroups(rows);
  const nEmpty = rows.filter((R) => !R.anns.length).length;
  $("#status").textContent =
    `${rows.length} paper${rows.length === 1 ? "" : "s"}` +
    (S.ui.includeUnannotated ? ` (${nEmpty} without annotations)` : "") +
    ` · ${shown.length} annotations`;
  $("#collapseAllBtn").textContent = anyPaperExpanded() ? "Collapse all" : "Expand all";

  const cols = visiblePaperColumns();
  renderPaperHead(cols);

  const tbody = $("#grid tbody");
  tbody.textContent = "";
  $("#empty").hidden = rows.length > 0;
  $("#empty").textContent = S.all.length ? "No papers match the current filters." : "No annotations found.";

  const grouped = S.ui.pGroupBy !== "none";
  const collapsed = new Set(S.ui.collapsed[`p:${S.ui.pGroupBy}`] || []);
  const frag = document.createDocumentFragment();
  for (const g of S.paperGroups) {
    const isCollapsed = grouped && collapsed.has(g.key);
    if (grouped) frag.append(renderPaperGroupRow(g, cols.length, isCollapsed));
    if (!isCollapsed) for (const R of g.items) frag.append(renderPaperRow(R, cols));
  }
  tbody.append(frag);
}

function renderPaperRow(R, cols) {
  const collapsed = isPaperCollapsed(R);
  const tr = h("tr", { class: `prow${collapsed ? " collapsed" : ""}${R.anns.length ? "" : " empty-paper"}` });
  cols.forEach((k, i) => {
    const def = paperColDef(k);
    const content = isColorCol(k) ? def.render(R) : h("div", { class: "cell" }, def.render(R));
    const td = h("td", { class: isColorCol(k) ? "c-colorcol" : `c-${k}` });
    if (i === 0) {
      // The collapse triangle lives in whichever column is first.
      const caret = R.anns.length
        ? h(
            "button",
            {
              class: "pcaret",
              title: collapsed ? "Expand this paper" : "Collapse this paper",
              onclick: (e) => {
                e.stopPropagation();
                togglePaper(R);
              },
            },
            collapsed ? "▸" : "▾",
          )
        : h("span", { class: "pcaret" });
      td.append(h("div", { class: "first" }, caret, content));
    } else if (content) td.append(content);
    tr.append(td);
  });
  return tr;
}

function makePaperGroups(rows) {
  if (S.ui.pGroupBy !== "paperTag") return [{ key: "all", items: rows }];
  const groups = new Map();
  const add = (key, label, R) => {
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key).items.push(R);
  };
  for (const R of rows) {
    if (!R.paper.tags.length) add(UNTAGGED, "Untagged", R);
    for (const t of R.paper.tags) add(t, t, R);
  }
  return [...groups.values()].sort(
    (a, b) => (a.key === UNTAGGED) - (b.key === UNTAGGED) || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

function renderPaperGroupRow(g, ncols, isCollapsed) {
  const n = g.items.reduce((s, R) => s + R.anns.length, 0);
  const td = h(
    "td",
    { colspan: ncols },
    h(
      "div",
      { class: "g-inner" },
      h("span", { class: "caret" }, isCollapsed ? "▸" : "▾"),
      h("span", { class: "g-label" }, g.label),
      h("span", { class: "n" }, `${g.items.length} paper${g.items.length === 1 ? "" : "s"} · ${n} annotations`),
      h(
        "button",
        {
          title: "Copy these papers as Markdown notes",
          onclick: (e) => {
            e.stopPropagation();
            copy(g.items.map(paperMarkdown).join("\n"), `Copied ${g.items.length} papers`);
          },
        },
        "Copy",
      ),
    ),
  );
  const key = `p:${S.ui.pGroupBy}`;
  return h(
    "tr",
    {
      class: "group",
      onclick: () => {
        const set = new Set(S.ui.collapsed[key] || []);
        set.has(g.key) ? set.delete(g.key) : set.add(g.key);
        S.ui.collapsed[key] = [...set];
        saveUI();
        render();
      },
    },
    td,
  );
}

function renderPaperHead(cols) {
  const colgroup = $("#grid colgroup");
  colgroup.textContent = "";
  let total = 0;
  for (const k of cols) {
    const w = S.ui.widths[k] || paperColDef(k).width;
    total += w;
    colgroup.append(h("col", { "data-col": k, style: `width:${w}px` }));
  }
  $("#grid").style.width = `${total}px`;

  const tr = h("tr");
  cols.forEach((k, i) => {
    const def = paperColDef(k);
    const s = S.ui.psort;
    const label = h(
      "span",
      {
        class: "th-label",
        title: def.color ? `${def.label} — click to sort by count, drag to move` : `Sort by ${def.label.toLowerCase()}, drag to move`,
        onclick: () => {
          // A color column sorts papers with the most notes of that color first.
          const first = def.color || k === "count" ? -1 : 1;
          if (!s || s.col !== k) S.ui.psort = { col: k, dir: first };
          else if (s.dir === first) S.ui.psort = { col: k, dir: -first };
          else S.ui.psort = null;
          saveUI();
          render();
        },
      },
      def.color ? h("span", { class: `swatch${def.underline ? " ul" : ""}`, style: `background:${def.color}` }) : null,
      def.label,
      s && s.col === k ? h("span", { class: "sort" }, s.dir === 1 ? " ▲" : " ▼") : null,
    );
    const inner = h("div", { class: "th-inner" });
    if (i === 0) {
      const expanded = anyPaperExpanded();
      inner.append(
        h(
          "button",
          {
            class: "pcaret",
            title: expanded ? "Collapse all papers" : "Expand all papers",
            onclick: (e) => {
              e.stopPropagation();
              setAllPapersCollapsed(expanded);
            },
          },
          expanded ? "▾" : "▸",
        ),
      );
    }
    inner.append(label);
    const th = h("th", {}, inner, h("span", { class: "resizer", onmousedown: (e) => startResize(e, k) }));
    makeDraggable(th, k, "pcols");
    tr.append(th);
  });
  const thead = $("#grid thead");
  thead.textContent = "";
  thead.append(tr);
}

// Drag a header onto another to move the column there.
function makeDraggable(th, k, listKey) {
  th.draggable = true;
  th.addEventListener("dragstart", (e) => {
    if (e.target.closest?.(".resizer")) return e.preventDefault();
    e.dataTransfer.setData("text/x-annotable-col", k);
    e.dataTransfer.effectAllowed = "move";
  });
  th.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("text/x-annotable-col")) return;
    e.preventDefault();
    th.classList.add("drop");
  });
  th.addEventListener("dragleave", () => th.classList.remove("drop"));
  th.addEventListener("drop", (e) => {
    e.preventDefault();
    th.classList.remove("drop");
    const from = e.dataTransfer.getData("text/x-annotable-col");
    if (!from || from === k) return;
    const list = S.ui[listKey].filter((x) => x !== from);
    list.splice(list.indexOf(k) + (S.ui[listKey].indexOf(from) < S.ui[listKey].indexOf(k) ? 1 : 0), 0, from);
    S.ui[listKey] = list;
    saveUI();
    render();
  });
}

function openPaperColumnsPopover(anchor) {
  openPopover(anchor, (pop) => {
    const list = h("div", { class: "opts" });
    const toggle = (k, on) => {
      if (on) {
        if (!S.ui.pcols.includes(k)) S.ui.pcols.push(k);
      } else S.ui.pcols = S.ui.pcols.filter((x) => x !== k);
      saveUI();
      render();
    };
    const row = (k, label, sw, ul) => {
      const cb = h("input", { type: "checkbox", checked: S.ui.pcols.includes(k) });
      cb.addEventListener("change", () => toggle(k, cb.checked));
      return h(
        "label",
        { class: `opt${ul ? " sub" : ""}` },
        cb,
        sw ? h("span", { class: `swatch${ul ? " ul" : ""}`, style: `background:${sw}` }) : null,
        h("span", { class: "lbl" }, label),
      );
    };
    list.append(h("div", { class: "more" }, "Paper"));
    for (const [k, col] of Object.entries(PAPER_COLUMNS)) list.append(row(k, col.label));
    list.append(h("div", { class: "more" }, "Highlights / underlines (drag headers to reorder)"));
    for (const c of colorChoices()) {
      list.append(row(`color:${c}`, colorLabel(c), c, false), row(`underline:${c}`, underlineLabel(c), c, true));
    }
    pop.append(list);
  });
}

// --- markdown

function paperMarkdown(R) {
  const p = R.paper;
  const lines = [`## ${p.citekey} — ${p.title}${p.year ? ` (${p.year})` : ""}`];
  const meta = [p.authors, p.tags.length ? p.tags.map((t) => `#${t.replace(/\s+/g, "-")}`).join(" ") : ""].filter(Boolean);
  if (meta.length) lines.push(meta.join(" · "));
  const bullet = (a) => {
    const body = a.text ? oneLine(a.text) : a.type === 3 ? "*(image)*" : a.type === 4 ? "*(ink)*" : "";
    const comment = a.comment ? oneLine(mdText(a.comment)) : "";
    const link = `([p. ${a.pageLabel || "?"}](${zoteroLink(a)}))`;
    const first = `- ${body || comment} ${link}`;
    return body && comment ? `${first}\n  - ${comment}` : first;
  };
  for (const k of visiblePaperColumns()) {
    if (!isColorCol(k)) continue;
    const def = paperColDef(k);
    const list = cellList(R, def.color, def.underline);
    if (list.length) lines.push("", `### ${def.label}`, ...list.map(bullet));
  }
  return lines.join("\n") + "\n";
}

function exportPapersMarkdown() {
  const rows = S.paperRows || [];
  const header = `# Literature notes\n_${new Date().toISOString().slice(0, 10)} · ${rows.length} papers_\n`;
  copy(`${header}\n${rows.map(paperMarkdown).join("\n")}`, `Copied ${rows.length} papers as Markdown`);
}

// ---------------------------------------------------------------------------
// editing (writes back to Zotero)

const snapshot = (a) => ({ id: a.id, color: a.color, comment: a.comment, tags: [...a.tags] });

// Applies change(item) to each editable record's Zotero item in one transaction,
// refreshes the records from the saved items and offers an undo.
async function saveAnnotations(records, change, describe, { confirmBulk = true, undoable = true } = {}) {
  const editable = records.filter((a) => !a.readOnly);
  const skipped = records.length - editable.length;
  if (!editable.length) {
    toast(skipped ? "Imported PDF annotations can't be edited in Zotero" : "Nothing to change");
    return false;
  }
  if (confirmBulk && editable.length > 1) {
    const extra = skipped ? `\n\n${skipped} imported PDF annotation(s) will be skipped.` : "";
    if (!window.confirm(`${describe} for ${editable.length} annotations?${extra}`)) return false;
  }
  const before = editable.map(snapshot);
  try {
    const items = (await Zotero.Items.getAsync(editable.map((a) => a.id))).filter(Boolean);
    await Zotero.Items.loadDataTypes(items, ["annotation", "annotationDeferred", "tags"]);
    S.ignoreNotifyUntil = Date.now() + 3000;
    await Zotero.DB.executeTransaction(async () => {
      for (const item of items) {
        if (!item.isEditable()) continue;
        change(item);
        await item.save();
      }
    });
    const byID = new Map(items.map((it) => [it.id, it]));
    for (const a of editable) {
      const it = byID.get(a.id);
      if (!it) continue;
      a.color = (it.annotationColor || "").toLowerCase();
      a.comment = it.annotationComment || "";
      a.tags = it
        .getTags()
        .map((t) => t.tag)
        .sort((x, y) => x.localeCompare(y));
      delete a._search;
    }
  } catch (e) {
    Zotero.logError(e);
    toast(`Saving failed: ${e.message || e}`);
    reload();
    return false;
  }
  render();
  const n = editable.length;
  const msg = `${describe}: ${n} annotation${n === 1 ? "" : "s"}` + (skipped ? ` (${skipped} read-only skipped)` : "");
  toast(msg, undoable ? { label: "Undo", run: () => restore(before) } : null);
  return true;
}

function restore(before) {
  const byID = new Map(before.map((b) => [b.id, b]));
  const records = S.all.filter((a) => byID.has(a.id));
  saveAnnotations(
    records,
    (item) => {
      const b = byID.get(item.id);
      if (b.color) item.annotationColor = b.color;
      item.annotationComment = b.comment;
      item.setTags(b.tags.map((tag) => ({ tag })));
    },
    "Undone",
    { confirmBulk: false, undoable: false },
  );
}

function editComment(td, a) {
  if (td.classList.contains("editing")) return;
  td.classList.add("editing");
  const cell = td.querySelector(".cell");
  const ta = h("textarea", { rows: 3 });
  ta.value = a.comment;
  cell.replaceWith(ta);
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  fit();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    td.classList.remove("editing");
    const text = ta.value.replace(/\s+$/, "");
    if (save && text !== a.comment) {
      await saveAnnotations([a], (item) => (item.annotationComment = text), "Comment saved");
    } else render();
  };
  ta.addEventListener("input", fit);
  ta.addEventListener("click", (e) => e.stopPropagation());
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      finish(false);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    }
  });
  ta.addEventListener("blur", () => finish(true));
}

function allAnnotationTags() {
  const counts = new Map();
  for (const a of S.all) for (const t of a.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

// Tag picker with search-or-create. 'onPick(tag, checked)' is called per toggle.
function openTagPicker(anchor, { title, tags, isChecked, onPick, allowCreate = true }) {
  openPopover(anchor, (pop) => {
    const search = h("input", { type: "search", placeholder: allowCreate ? "Find or create a tag…" : "Find a tag…" });
    const list = h("div", { class: "opts" });
    const draw = () => {
      const q = search.value.trim();
      const ql = q.toLowerCase();
      list.textContent = "";
      if (title) list.append(h("div", { class: "more" }, title));
      const names = [...tags.keys()]
        .filter((t) => !ql || t.toLowerCase().includes(ql))
        .sort((x, y) => isChecked(y) - isChecked(x) || tags.get(y) - tags.get(x) || x.localeCompare(y));
      if (allowCreate && q && !tags.has(q)) {
        list.append(
          h(
            "div",
            {
              class: "opt create",
              onclick: async () => {
                tags.set(q, 0);
                search.value = "";
                await onPick(q, true);
                draw();
              },
            },
            h("span", { class: "lbl" }, `+ Create “${q}”`),
          ),
        );
      }
      for (const t of names.slice(0, 300)) {
        const cb = h("input", { type: "checkbox", checked: isChecked(t) });
        const row = h("label", { class: "opt" }, cb, h("span", { class: `pill ${tagClass(t)}` }, t), h("span", { class: "n" }, tags.get(t) || ""));
        cb.addEventListener("change", async () => {
          await onPick(t, cb.checked);
          draw();
        });
        list.append(row);
      }
      if (!names.length && !(allowCreate && q)) list.append(h("div", { class: "more" }, "No tags"));
    };
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") list.querySelector(".opt.create, .opt input")?.click();
    });
    search.addEventListener("input", draw);
    draw();
    pop.append(search, list);
  });
}

function openTagEditor(td, a) {
  openTagPicker(td, {
    tags: allAnnotationTags(),
    isChecked: (t) => a.tags.includes(t),
    onPick: (t, checked) =>
      saveAnnotations([a], (item) => (checked ? item.addTag(t) : item.removeTag(t)), checked ? `Tagged “${t}”` : `Removed “${t}”`),
  });
}

function colorChoices() {
  const counts = new Map();
  for (const a of S.all) counts.set(a.color, (counts.get(a.color) || 0) + 1);
  for (const c of PALETTE_ORDER) if (!counts.has(c)) counts.set(c, 0);
  return [...counts.keys()].filter(Boolean).sort((x, y) => colorRank(x, counts) - colorRank(y, counts));
}

function openColorPicker(anchor, records) {
  const current = records.length === 1 ? records[0].color : null;
  openPopover(anchor, (pop) => {
    const list = h("div", { class: "opts" });
    for (const c of colorChoices()) {
      list.append(
        h(
          "div",
          {
            class: `opt${c === current ? " sel" : ""}`,
            title: c,
            onclick: () => {
              closePopover();
              if (c === current) return;
              saveAnnotations(records, (item) => (item.annotationColor = c), `Color set to ${colorLabel(c)}`);
            },
          },
          swatch(c),
          h("span", { class: "lbl" }, colorLabel(c)),
          ZOTERO_COLORS[c] ? null : h("span", { class: "n" }, c),
        ),
      );
    }
    pop.append(list);
  });
}

function toggleSelect(a, on, range) {
  if (range && S.lastClicked != null) {
    const ids = S.shown.map((x) => x.id);
    const i = ids.indexOf(S.lastClicked);
    const j = ids.indexOf(a.id);
    if (i >= 0 && j >= 0) {
      for (const id of ids.slice(Math.min(i, j), Math.max(i, j) + 1)) on ? S.selected.add(id) : S.selected.delete(id);
    }
  } else {
    on ? S.selected.add(a.id) : S.selected.delete(a.id);
  }
  S.lastClicked = a.id;
  render();
}

function renderSelectionBar() {
  const bar = $("#selBar");
  const selected = S.all.filter((a) => S.selected.has(a.id));
  bar.hidden = !selected.length;
  bar.textContent = "";
  if (!selected.length) return;
  const shownIDs = new Set(S.shown.map((a) => a.id));
  const hiddenN = selected.filter((a) => !shownIDs.has(a.id)).length;
  bar.append(
    h("span", { class: "sel-count" }, `${selected.length} selected` + (hiddenN ? ` (${hiddenN} hidden by filters)` : "")),
    h("button", { onclick: (e) => openColorPicker(e.currentTarget, selected) }, "Set color ▾"),
    h(
      "button",
      {
        onclick: (e) =>
          openTagPicker(e.currentTarget, {
            title: "Add a tag to the selected annotations",
            tags: allAnnotationTags(),
            isChecked: () => false,
            onPick: async (t) => {
              closePopover();
              await saveAnnotations(selected, (item) => item.addTag(t), `Tagged “${t}”`);
            },
          }),
      },
      "Add tag ▾",
    ),
    h(
      "button",
      {
        onclick: (e) => {
          const counts = new Map();
          for (const a of selected) for (const t of a.tags) counts.set(t, (counts.get(t) || 0) + 1);
          openTagPicker(e.currentTarget, {
            title: "Remove a tag from the selected annotations",
            tags: counts,
            allowCreate: false,
            isChecked: () => false,
            onPick: async (t) => {
              closePopover();
              await saveAnnotations(
                selected.filter((a) => a.tags.includes(t)),
                (item) => item.removeTag(t),
                `Removed “${t}”`,
              );
            },
          });
        },
      },
      "Remove tag ▾",
    ),
    h(
      "button",
      {
        class: "clear-sel",
        onclick: () => {
          S.selected.clear();
          render();
        },
      },
      "Clear selection",
    ),
  );
}


// ---------------------------------------------------------------------------
// markdown

function zoteroLink(a) {
  const lib = Zotero.Libraries.get(a.libraryID);
  const prefix = lib?.libraryType === "group" ? `groups/${lib.groupID}` : "library";
  return `zotero://open-pdf/${prefix}/items/${a.attKey}?annotation=${a.key}`;
}

const oneLine = (s) => s.replace(/\s*\n\s*/g, " ").trim();

function annotationMarkdown(a) {
  const cite = `[@${a.paper.citekey}${a.pageLabel ? `, p. ${a.pageLabel}` : ""}](${zoteroLink(a)})`;
  const body = a.text ? `==${oneLine(a.text)}==` : a.type === 3 ? "*(image)*" : a.type === 4 ? "*(ink)*" : "";
  const comment = a.comment ? oneLine(mdText(a.comment)) : "";
  const parts = [body, body && comment ? `— ${comment}` : comment, `(${cite})`].filter(Boolean);
  const tags = a.tags.map((t) => `#${t.replace(/\s+/g, "-")}`).join(" ");
  return `- ${parts.join(" ")}${tags ? " " + tags : ""}`;
}

function groupMarkdown(g, heading) {
  const sub = g.sub && S.ui.groupBy !== "paper" ? ` (${g.sub})` : g.paper ? ` — ${g.sub}` : "";
  return [`${heading} ${g.label}${sub}`, "", ...g.items.map(annotationMarkdown), ""].join("\n");
}

function exportMarkdown() {
  const n = S.shown.length;
  const header = `# Annotations\n_${new Date().toISOString().slice(0, 10)} · ${n} annotations_\n`;
  const body =
    S.ui.groupBy === "none" ? S.shown.map(annotationMarkdown).join("\n") : S.groups.map((g) => groupMarkdown(g, "##")).join("\n");
  copy(`${header}\n${body}`, `Copied ${n} annotations as Markdown`);
}

// ---------------------------------------------------------------------------
// actions

let toastTimer;
function toast(msg, action) {
  const t = $("#toast");
  t.textContent = msg;
  if (action) {
    t.append(
      h(
        "button",
        {
          onclick: () => {
            t.hidden = true;
            action.run();
          },
        },
        action.label,
      ),
    );
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 8000 : 1800);
}

function copy(text, msg) {
  Zotero.Utilities.Internal.copyTextToClipboard(text);
  toast(msg);
}

async function openInReader(a) {
  try {
    await Zotero.Reader.open(a.attID, { annotationID: a.key });
    Zotero.getMainWindow()?.focus();
  } catch (e) {
    Zotero.logError(e);
    toast("Could not open the attachment");
  }
}

async function selectInLibrary(itemID) {
  const win = Zotero.getMainWindow();
  if (!win) return;
  win.Zotero_Tabs?.select("zotero-pane");
  await win.ZoteroPane.selectItem(itemID);
  win.focus();
}

function openColorDialog() {
  const counts = new Map();
  for (const a of S.all) counts.set(a.color, (counts.get(a.color) || 0) + 1);
  for (const c of PALETTE_ORDER) if (!counts.has(c)) counts.set(c, 0);
  const colors = [...counts.keys()].filter(Boolean).sort((a, b) => colorRank(a, counts) - colorRank(b, counts));
  const rows = $("#colorRows");
  rows.textContent = "";
  rows.append(
    h("div", { class: "color-row head" }, h("span"), h("span"), h("span", {}, "Highlight means…"), h("span", {}, "Underline means…"), h("span")),
  );
  for (const c of colors) {
    rows.append(
      h(
        "div",
        { class: "color-row" },
        swatch(c),
        h("code", {}, c),
        h("input", { type: "text", "data-key": c, value: S.colorLabels[c] || "", placeholder: ZOTERO_COLORS[c] || "(unnamed)" }),
        h("input", { type: "text", "data-key": `${c}|underline`, value: S.colorLabels[`${c}|underline`] || "", placeholder: "Underlined" }),
        h("span", { class: "n" }, counts.get(c)),
      ),
    );
  }
  $("#colorDialog").showModal();
}

function saveColorDialog() {
  const labels = {};
  for (const input of document.querySelectorAll("#colorRows input")) {
    const v = input.value.trim();
    if (v) labels[input.dataset.key] = v;
  }
  S.colorLabels = labels;
  Zotero.Prefs.set(PREF_COLORS, JSON.stringify(labels), true);
  for (const a of S.all) delete a._search;
  renderFilterBar();
  render();
}

// "Show Annotations" on selected library items: becomes a Citekey filter.
function setItemFilter(ids) {
  const want = new Set((ids || []).map(Number));
  const keys = [...new Set(S.all.filter((a) => want.has(a.paper.id)).map((a) => a.paper.citekey))];
  const conds = S.ui.filter.conds.filter((c) => c.field !== "citekey");
  if (keys.length) conds.unshift({ field: "citekey", op: "any", values: keys });
  else if (ids?.length) toast("The selected items have no annotations");
  S.ui.filter.conds = conds;
  filtersChanged(true);
}

// ---------------------------------------------------------------------------
// startup

let reloadTimer;
function scheduleReload() {
  if (Date.now() < S.ignoreNotifyUntil) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    // Don't yank an open editor away; try again once the user is done.
    if (document.querySelector("td.editing") || !$("#popover").hidden) scheduleReload();
    else reload();
  }, 800);
}

async function reload() {
  $("#refresh").disabled = true;
  try {
    await loadAnnotations();
    S.unannotated = null;
    if (S.ui.includeUnannotated) await loadAllPapers();
    const ids = new Set(S.all.map((a) => a.id));
    for (const id of S.selected) if (!ids.has(id)) S.selected.delete(id);
    buildScopeSelect();
    render();
  } catch (e) {
    Zotero.logError(e);
    $("#empty").hidden = false;
    $("#empty").textContent = `Failed to load annotations: ${e.message || e}`;
  } finally {
    $("#refresh").disabled = false;
  }
}

function loadUI() {
  const saved = readJSONPref(PREF_UI);
  const ui = Object.assign(structuredClone(DEFAULT_UI), saved);
  // Settings from the old card view: drop what no longer applies.
  if (!["none", "color", "paperTag", "tag", "paper", "type"].includes(ui.groupBy)) ui.groupBy = "none";
  if (!["1", "3", "0"].includes(String(ui.rowLines))) ui.rowLines = "3";
  ui.rowLines = String(ui.rowLines);
  if (!ui.filter?.conds) ui.filter = { conj: "and", conds: [] };
  ui.filter.conds = ui.filter.conds.filter((c) => FIELDS[c.field]);
  ui.collapsed ||= {};
  ui.widths ||= {};
  if (!["papers", "annotations"].includes(ui.view)) ui.view = "papers";
  if (!Array.isArray(ui.pcols)) ui.pcols = structuredClone(DEFAULT_UI.pcols);
  if (!["none", "paperTag"].includes(ui.pGroupBy)) ui.pGroupBy = "none";
  if (!Array.isArray(ui.pToggled)) ui.pToggled = [];
  if (!ui.paperTagsColumnAdded) {
    if (!ui.columns.includes("paperTags")) ui.columns = Object.keys(COLUMNS).filter((k) => k === "paperTags" || ui.columns.includes(k));
    ui.paperTagsColumnAdded = true;
  }
  delete ui.sortBy;
  delete ui.compact;
  S.ui = ui;
}

let scopeDropdown;

function syncViewControls() {
  for (const b of document.querySelectorAll("#viewSwitch button")) b.classList.toggle("on", b.dataset.view === S.ui.view);
  const papers = S.ui.view === "papers";
  $("#groupBy").hidden = papers;
  $("#pGroupBy").hidden = !papers;
  $("#unannotatedBtn").hidden = !papers;
  $("#collapseAllBtn").hidden = !papers;
  $("#unannotatedBtn").classList.toggle("on", !!S.ui.includeUnannotated);
  $("#export").title = papers ? "Copy the papers shown as Markdown literature notes" : "Copy the rows shown as Markdown (Obsidian-friendly)";
}

function bindControls() {
  let searchTimer;
  $("#search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 150);
  });
  const toolbarDropdown = (slot, key, options, after) => {
    const dd = dropdown({
      options,
      value: S.ui[key],
      onChange: (v) => {
        S.ui[key] = v;
        after?.();
        saveUI();
        render();
      },
    });
    dd.id = slot.slice(1);
    $(slot).replaceWith(dd);
    return dd;
  };
  scopeDropdown = toolbarDropdown("#scope", "scope", [{ value: "all", label: "All libraries" }], computeScopeIDs);
  const viewBtn = (v, label) =>
    h(
      "button",
      {
        "data-view": v,
        onclick: () => {
          if (S.ui.view === v) return;
          S.ui.view = v;
          saveUI();
          $("#results").scrollTop = 0;
          render();
        },
      },
      label,
    );
  $("#viewSwitch").append(viewBtn("papers", "Papers"), viewBtn("annotations", "Annotations"));
  const pGroup = dropdown({
    options: [
      { value: "none", label: "None" },
      { value: "paperTag", label: "Paper tag" },
    ],
    value: S.ui.pGroupBy,
    onChange: (v) => {
      S.ui.pGroupBy = v;
      saveUI();
      render();
    },
  });
  pGroup.id = "pGroupBy";
  $("#groupBy").after(pGroup);
  toolbarDropdown("#groupBy", "groupBy", [
    { value: "none", label: "None" },
    { value: "color", label: "Color" },
    { value: "paperTag", label: "Paper tag" },
    { value: "tag", label: "Annotation tag" },
    { value: "paper", label: "Paper" },
    { value: "type", label: "Type" },
  ]);
  toolbarDropdown("#rowLines", "rowLines", [
    { value: "1", label: "1 line" },
    { value: "3", label: "3 lines" },
    { value: "0", label: "Full" },
  ]);
  $("#unannotatedBtn").addEventListener("click", async () => {
    S.ui.includeUnannotated = !S.ui.includeUnannotated;
    saveUI();
    if (S.ui.includeUnannotated && !S.unannotated) {
      $("#unannotatedBtn").disabled = true;
      try {
        await loadAllPapers();
      } catch (e) {
        Zotero.logError(e);
        toast("Couldn't load papers without annotations");
      } finally {
        $("#unannotatedBtn").disabled = false;
      }
    }
    render();
  });
  $("#collapseAllBtn").addEventListener("click", () => setAllPapersCollapsed(anyPaperExpanded()));
  $("#columnsBtn").addEventListener("click", (e) =>
    S.ui.view === "papers" ? openPaperColumnsPopover(e.currentTarget) : openColumnsPopover(e.currentTarget),
  );
  $("#colors").addEventListener("click", openColorDialog);
  $("#saveColors").addEventListener("click", saveColorDialog);
  $("#export").addEventListener("click", () => (S.ui.view === "papers" ? exportPapersMarkdown() : exportMarkdown()));
  $("#refresh").addEventListener("click", reload);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.selected.size && $("#popover").hidden && !document.querySelector("td.editing")) {
      S.selected.clear();
      render();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      $("#search").focus();
      $("#search").select();
    }
  });
}

async function init() {
  if (!Zotero) {
    document.body.textContent = "Zotero is not available in this window.";
    return;
  }
  S.colorLabels = readJSONPref(PREF_COLORS);
  loadUI();
  bindControls();
  renderFilterBar();

  const observerID = Zotero.Notifier.registerObserver(
    { notify: () => scheduleReload() },
    ["item", "item-tag", "collection", "collection-item"],
    "zotero-annotable",
  );
  window.addEventListener("unload", () => Zotero.Notifier.unregisterObserver(observerID));

  await reload();
  const ids = new URLSearchParams(location.search).get("items");
  if (ids) setItemFilter(ids.split(",").map(Number));
}

window.Annotable = { setItemFilter, reload };
init();
