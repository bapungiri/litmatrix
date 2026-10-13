/* global Zotero */
const tableBody = document.querySelector("#annotations-table tbody");
const filterInput = document.querySelector("#filter");
const refreshButton = document.querySelector("#refresh");
const headers = Array.from(document.querySelectorAll("th[data-key]"));

let rows = [];
let sortState = { key: "annotation", dir: "asc" };

async function loadData() {
    refreshButton.disabled = true;
    refreshButton.textContent = "Loading...";
    try {
        rows = await fetchAnnotations();
        render();
    } catch (err) {
        console.error("Failed to load annotations", err);
        renderEmpty("Unable to load annotations; see console.");
    } finally {
        refreshButton.disabled = false;
        refreshButton.textContent = "Refresh";
    }
}

async function fetchAnnotations() {
    if (Zotero.Items?.waitForAllLoaded) {
        await Zotero.Items.waitForAllLoaded();
    }
    let ids = [];
    if (Zotero.Annotations?.getAllIDs) {
        ids = await Zotero.Annotations.getAllIDs();
    } else if (Zotero.Annotations?.getAll) {
        ids = (await Zotero.Annotations.getAll()).map((a) => a.id);
    }
    const anns = await Zotero.Annotations.getMultiple(ids, { loadAllData: true });
    return anns.map((ann) => {
        const parent = ann.getParentItem?.() || (ann.parentItemID ? Zotero.Items.get(ann.parentItemID) : null);
        const tags = (ann.tags || []).map((t) => t.tag).join(", ");
        const citationKey = parent?.getField ? parent.getField("citationKey") : parent?.key || "";
        return {
            id: ann.id,
            parentItemID: ann.parentItemID || parent?.id,
            annotation: ann.text || ann.annotationText || "",
            color: ann.color || "",
            tags,
            comment: ann.comment || "",
            citationKey,
        };
    });
}

function render() {
    const term = filterInput.value.trim().toLowerCase();
    let filtered = rows;
    if (term) {
        filtered = rows.filter((row) =>
            [row.annotation, row.tags, row.comment, row.citationKey]
                .filter(Boolean)
                .some((v) => v.toLowerCase().includes(term)),
        );
    }

    filtered.sort((a, b) => {
        const { key, dir } = sortState;
        const av = (a[key] || "").toLowerCase();
        const bv = (b[key] || "").toLowerCase();
        if (av === bv) return 0;
        const res = av > bv ? 1 : -1;
        return dir === "asc" ? res : -res;
    });

    if (!filtered.length) {
        renderEmpty("No annotations found.");
        return;
    }

    tableBody.innerHTML = "";
    for (const row of filtered) {
        const tr = document.createElement("tr");
        tr.dataset.itemId = row.parentItemID || "";

        tr.appendChild(tdText(row.annotation, "annotation"));
        tr.appendChild(tdColor(row.color));
        tr.appendChild(tdTags(row.tags));
        tr.appendChild(tdText(row.comment, "comment"));
        tr.appendChild(tdText(row.citationKey, "citationKey"));

        tr.addEventListener("click", () => {
            const id = Number(tr.dataset.itemId);
            if (!id) return;
            openItem(id);
        });

        tableBody.appendChild(tr);
    }
}

function openItem(itemID) {
    try {
        const mainWin = Zotero.getMainWindow?.() || window;
        const pane = mainWin?.ZoteroPane;
        if (pane?.selectItem) {
            pane.selectItem(itemID);
            if (pane.collectionsView) {
                pane.collectionsView.ensureRowIsVisible(pane.getCollectionTreeRowForItem(itemID));
            }
        }
    } catch (err) {
        console.error("openItem failed", err);
    }
}

function renderEmpty(message) {
    tableBody.innerHTML = `<tr><td colspan="5"><div class="empty-state">${message}</div></td></tr>`;
}

function tdText(value, cls) {
    const td = document.createElement("td");
    td.textContent = value || "";
    if (cls) td.classList.add(cls);
    return td;
}

function tdColor(color) {
    const td = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "badge-color";
    const swatch = document.createElement("span");
    swatch.className = "badge-swatch";
    swatch.style.background = color || "#ccc";
    const label = document.createElement("span");
    label.textContent = color || "";
    wrap.append(swatch, label);
    td.appendChild(wrap);
    return td;
}

function tdTags(tags) {
    const td = document.createElement("td");
    const parts = (tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    if (!parts.length) {
        td.textContent = "";
        return td;
    }
    for (const tag of parts) {
        const pill = document.createElement("span");
        pill.className = "tag-pill";
        pill.textContent = tag;
        td.appendChild(pill);
    }
    return td;
}

headers.forEach((th) => {
    th.addEventListener("click", () => {
        const key = th.dataset.key;
        if (sortState.key === key) {
            sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
        } else {
            sortState = { key, dir: "asc" };
        }
        headers.forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
        th.classList.add(sortState.dir === "asc" ? "sorted-asc" : "sorted-desc");
        render();
    });
});

filterInput.addEventListener("input", () => render());
refreshButton.addEventListener("click", () => loadData());

loadData();
