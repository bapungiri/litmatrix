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
  filter: { conj: "and", conds: [] },
};

const S = {
  all: [], // annotation records, see loadAnnotations()
  colorLabels: {},
  ui: structuredClone(DEFAULT_UI),
  scopeIDs: null, // Set of top-level item IDs in the selected collection, or null
  shown: [],
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
            a.sortIndex AS sortIndex, i.dateAdded AS dateAdded
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
    get: (a) => a.comment,
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
    a._search = [a.text, a.comment, a.paper.citekey, a.paper.title, a.paper.authors, a.paper.year, a.tags.join(" "), a.paper.tags.join(" "), colorLabel(a.color)]
      .join("\n")
      .toLowerCase();
  }
  return a._search;
}

// Records in scope and matching the quick search; the filter builder narrows these further.
function baseRecords() {
  const terms = $("#search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [kind, id] = S.ui.scope.split(":");
  return S.all.filter((a) => {
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
  comment: { label: "Comment", width: 300, sortKey: (a) => a.comment.toLowerCase() || "￿", render: (a) => a.comment },
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
  const copyBtn = h(
    "button",
    {
      class: "row-copy",
      title: "Copy as Markdown",
      onclick: (e) => {
        e.stopPropagation();
        copy(annotationMarkdown(a), "Copied");
      },
    },
    "Copy",
  );
  return [copyBtn, body];
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
          // Keep the canonical column order.
          const order = Object.keys(COLUMNS);
          S.ui.columns = order.filter((x) => x === k || S.ui.columns.includes(x));
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
  S.groups = makeGroups(shown);

  const nPapers = new Set(shown.map((a) => a.paper.id)).size;
  $("#status").textContent = `${shown.length} of ${S.all.length} annotations · ${nPapers} paper${nPapers === 1 ? "" : "s"}`;
  document.body.dataset.lines = S.ui.rowLines;

  const cols = visibleColumns();
  renderHead(cols);

  const tbody = $("#grid tbody");
  const results = $("#results");
  const scroll = results.scrollTop;
  tbody.textContent = "";
  $("#empty").hidden = shown.length > 0;
  $("#empty").textContent = S.all.length ? "No annotations match the current filters." : "No annotations found.";

  const collapsed = new Set(S.ui.collapsed[S.ui.groupBy] || []);
  const frag = document.createDocumentFragment();
  for (const g of S.groups) {
    const isCollapsed = collapsed.has(g.key);
    if (S.ui.groupBy !== "none") frag.append(renderGroupRow(g, cols.length, isCollapsed));
    // Rows of collapsed groups are built when the group is first expanded.
    if (!isCollapsed) for (const a of g.items) frag.append(renderRow(a, cols));
  }
  tbody.append(frag);
  results.scrollTop = scroll;
}

function renderHead(cols) {
  const colgroup = $("#grid colgroup");
  colgroup.textContent = "";
  let total = 0;
  for (const k of cols) {
    const w = S.ui.widths[k] || COLUMNS[k].width;
    total += w;
    colgroup.append(h("col", { "data-col": k, style: `width:${w}px` }));
  }
  $("#grid").style.width = `${total}px`;

  const tr = h("tr");
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
  const startW = S.ui.widths[k] || COLUMNS[k].width;
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
    class: "row",
    onclick: () => {
      // Don't jump to the PDF when the user is selecting text to copy.
      if (!window.getSelection().isCollapsed) return;
      openInReader(a);
    },
  });
  for (const k of cols) {
    const td = h("td", { class: `c-${k}` }, h("div", { class: "cell" }, COLUMNS[k].render(a)));
    if (k === "annotation") td.style.setProperty("--c", a.color || "#999");
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
  const comment = a.comment ? oneLine(a.comment) : "";
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
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1800);
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
  for (const c of colors) {
    rows.append(
      h(
        "div",
        { class: "color-row" },
        swatch(c),
        h("code", {}, c),
        h("input", { type: "text", "data-color": c, value: S.colorLabels[c] || "", placeholder: ZOTERO_COLORS[c] || "(unnamed)" }),
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
    if (v) labels[input.dataset.color] = v;
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
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, 800);
}

async function reload() {
  $("#refresh").disabled = true;
  try {
    await loadAnnotations();
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
  if (!ui.paperTagsColumnAdded) {
    if (!ui.columns.includes("paperTags")) ui.columns = Object.keys(COLUMNS).filter((k) => k === "paperTags" || ui.columns.includes(k));
    ui.paperTagsColumnAdded = true;
  }
  delete ui.sortBy;
  delete ui.compact;
  S.ui = ui;
}

let scopeDropdown;

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
    $(slot).replaceWith(dd);
    return dd;
  };
  scopeDropdown = toolbarDropdown("#scope", "scope", [{ value: "all", label: "All libraries" }], computeScopeIDs);
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
  $("#columnsBtn").addEventListener("click", (e) => openColumnsPopover(e.currentTarget));
  $("#colors").addEventListener("click", openColorDialog);
  $("#saveColors").addEventListener("click", saveColorDialog);
  $("#export").addEventListener("click", exportMarkdown);
  $("#refresh").addEventListener("click", reload);
  window.addEventListener("keydown", (e) => {
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
