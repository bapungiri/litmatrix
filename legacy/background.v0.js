/* global Zotero */
// Background script for Zotero 7+ WebExtension-style plugin.

const TAB_ID = "zotero-annotable-tab";

async function waitForZotero() {
    if (globalThis.Zotero?.initialized) return;
    await new Promise(resolve => {
        const interval = setInterval(() => {
            if (globalThis.Zotero?.initialized) {
                clearInterval(interval);
                resolve();
            }
        }, 100);
    });
}

async function ensureTabRegistered() {
    await waitForZotero();
    const mainWindow = Zotero.getMainWindow();
    if (!mainWindow?.Zotero?.UI?.TabManager) return;

    const { TabManager } = mainWindow.Zotero.UI;
    if (TabManager.get?.(TAB_ID)) return;

    const url = browser.runtime.getURL("content/pane.html");
    TabManager.register({
        id: TAB_ID,
        title: "Annotations",
        icon: browser.runtime.getURL("content/icon.svg"),
        type: "html",
        src: url,
        allowMultiple: false,
    });
}

async function openTab() {
    await ensureTabRegistered();
    const mainWindow = Zotero.getMainWindow();
    const { TabManager } = mainWindow.Zotero.UI;
    if (TabManager.open) {
        TabManager.open(TAB_ID);
        return;
    }
    // Fallback: open by id via Zotero_Tabs if TabManager API differs.
    if (mainWindow.Zotero_Tabs?.open) {
        mainWindow.Zotero_Tabs.open({ id: TAB_ID, type: "html", url: browser.runtime.getURL("content/pane.html"), title: "Annotations" });
    }
}

async function fetchAllAnnotations() {
    await waitForZotero();
    // Ensure libraries loaded
    if (Zotero.Items?.waitForAllLoaded) {
        await Zotero.Items.waitForAllLoaded();
    }
    let annotationIDs = [];
    if (Zotero.Annotations?.getAllIDs) {
        annotationIDs = await Zotero.Annotations.getAllIDs();
    } else if (Zotero.Annotations?.getAll) {
        annotationIDs = (await Zotero.Annotations.getAll()).map(a => a.id);
    }

    const annotations = await Zotero.Annotations.getMultiple(annotationIDs, { loadAllData: true });
    return annotations.map((ann) => {
        const parent = ann.getParentItem?.() || (ann.parentItemID ? Zotero.Items.get(ann.parentItemID) : null);
        const tags = (ann.tags || []).map(t => t.tag).join(", ");
        const citationKey = parent?.getField ? parent.getField("citationKey") : "";
        const color = ann.color || "";
        const comment = ann.comment || "";
        const text = ann.text || ann.annotationText || "";
        return {
            id: ann.id,
            parentItemID: ann.parentItemID || parent?.id,
            annotation: text,
            color,
            tags,
            comment,
            citationKey,
        };
    });
}

async function selectItem(itemID) {
    await waitForZotero();
    const mainWindow = Zotero.getMainWindow();
    const zoteroPane = mainWindow?.ZoteroPane;
    if (!zoteroPane) return;
    zoteroPane.selectItem(itemID);
    if (zoteroPane.collectionsView) {
        zoteroPane.collectionsView.ensureRowIsVisible(zoteroPane.getCollectionTreeRowForItem(itemID));
    }
}

browser.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    if (message.type === "annotable.getAnnotations") {
        return fetchAllAnnotations();
    }
    if (message.type === "annotable.openItem" && message.itemID) {
        selectItem(message.itemID);
    }
});

browser.browserAction.onClicked.addListener(() => openTab());

// Auto-register on startup
ensureTabRegistered();
