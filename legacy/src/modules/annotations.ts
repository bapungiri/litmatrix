import { config } from "../../package.json";

const TAB_ID = `${config.addonRef}-tab`;
const VIEW_MENU_ITEM_ID = `${config.addonRef}-view-menuitem`;

function getTabManager(win: _ZoteroTypes.MainWindow) {
    return (win.Zotero as any)?.UI?.TabManager;
}

function getPrimaryMainWindow(): _ZoteroTypes.MainWindow | undefined {
    const wins = (Zotero.getMainWindows?.() || []) as unknown as _ZoteroTypes.MainWindow[];
    if (wins.length > 0) return wins[0];
    const legacy = (Zotero as any).getMainWindow?.();
    if (legacy) return legacy as _ZoteroTypes.MainWindow;
    if ((window as any).ZoteroPane) return window as unknown as _ZoteroTypes.MainWindow;
    return undefined;
}

export function registerAnnotationsTab(win: _ZoteroTypes.MainWindow) {
    const tabManager = getTabManager(win);
    if (!tabManager?.register) return;
    if (tabManager.get?.(TAB_ID)) return;
    const src = `${rootURI}chrome/content/annotable.html`;
    tabManager.register({
        id: TAB_ID,
        title: "Annotations",
        icon: addon.data.icons.icon || addon.data.icons.favicon,
        type: "html",
        src,
        allowMultiple: false,
        reloadAlways: true,
    });
}

export function openAnnotationsTab(win: _ZoteroTypes.MainWindow) {
    const targetWin = getPrimaryMainWindow() || win;
    const src = `${rootURI}chrome/content/annotable.html`;
    const tabManager = getTabManager(targetWin);
    if (tabManager?.open) {
        // Ensure tab is registered before opening (handles cases where startup register was skipped)
        if (!tabManager.get?.(TAB_ID)) {
            registerAnnotationsTab(targetWin);
        }
        try {
            tabManager.open(TAB_ID);
            return;
        } catch (e) {
            Zotero?.debug?.(`[annotable] TabManager open failed: ${e}`);
        }
    }
    const tabs = (targetWin as any).Zotero_Tabs;
    if (tabs?.open) {
        try {
            tabs.open({ id: TAB_ID, type: "html", url: src, title: "Annotations", icon: addon.data.icons.icon || addon.data.icons.favicon });
            return;
        } catch (e) {
            Zotero?.debug?.(`[annotable] Zotero_Tabs open failed: ${e}`);
        }
    }
}

export function ensureViewMenuItem(win: _ZoteroTypes.MainWindow) {
    const doc = win.document;
    const popup = doc.querySelector("#menu_viewPopup");
    if (!popup) return;
    if (doc.getElementById(VIEW_MENU_ITEM_ID)) return;
    const menuitem = (doc as any).createXULElement
        ? (doc as any).createXULElement("menuitem")
        : doc.createElement("menuitem");
    menuitem.id = VIEW_MENU_ITEM_ID;
    menuitem.setAttribute("label", "Annotations");
    menuitem.setAttribute("class", "menuitem-iconic");
    const icon = addon.data.icons.icon || addon.data.icons.favicon;
    if (icon) menuitem.setAttribute("image", icon);
    menuitem.addEventListener("command", () => openAnnotationsTab(win));
    popup.appendChild(menuitem);
}

export function removeViewMenuItem(win: _ZoteroTypes.MainWindow) {
    const existing = win.document.getElementById(VIEW_MENU_ITEM_ID);
    existing?.remove();
}
