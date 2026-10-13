/* global Zotero, Services, Components, APP_SHUTDOWN */
"use strict";

const ADDON_REF = "zotero-annotable";
const TAB_TYPE = "annotable"; // must not contain "-" (Zotero_Tabs.parseTabType splits on it)
const PAGE_URL = `chrome://${ADDON_REF}/content/annotable.html`;
const HTML_NS = "http://www.w3.org/1999/xhtml";
const WIN_KEY = "__zoteroAnnotable";

var chromeHandle = null;

function install() {}
function uninstall() {}

async function startup({ rootURI }) {
  await Zotero.initializationPromise;
  flushCaches();
  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", ADDON_REF, rootURI + "content/"],
  ]);
  Zotero.ZoteroAnnotable = { openTab, openWindow };
  for (const win of Zotero.getMainWindows()) {
    if (win.ZoteroPane) addToWindow(win);
  }
}

function onMainWindowLoad({ window }) {
  addToWindow(window);
}

function onMainWindowUnload({ window }) {
  removeFromWindow(window);
}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  for (const win of Zotero.getMainWindows()) removeFromWindow(win);
  Services.wm.getMostRecentWindow?.("zotero:annotable")?.close();
  delete Zotero.ZoteroAnnotable;
  chromeHandle?.destruct();
  chromeHandle = null;
  flushCaches();
}

// Otherwise an upgraded plugin can keep serving the previous version's CSS/HTML.
function flushCaches() {
  Services.obs.notifyObservers(null, "startupcache-invalidate");
  Services.obs.notifyObservers(null, "chrome-flush-caches");
}

// ---------------------------------------------------------------------------

function addToWindow(win) {
  if (win[WIN_KEY]) return;
  const doc = win.document;
  const state = { tabID: null, elements: [], origGetState: null };
  win[WIN_KEY] = state;

  const tabs = win.Zotero_Tabs;
  if (tabs) {
    // Never write our tab into session.json: Zotero has no restore hook for unknown
    // tab types and would throw while restoring tabs on the next start.
    state.origGetState = tabs.getState;
    tabs.getState = function () {
      const all = state.origGetState.call(this);
      const kept = all.filter((t) => t.type !== TAB_TYPE);
      if (kept.length && !kept.some((t) => t.selected)) kept[0].selected = true;
      return kept;
    };
    // Belt and braces, in case a stale session still lists the tab.
    if (tabs.tabHooks?.restoreState) {
      tabs.tabHooks.restoreState[TAB_TYPE] = async () => ({ itemID: null });
    }
    // Zotero only hides the item/notes side pane for the library tab, so coming from
    // a PDF tab would leave the reader's side pane over ours. Hide it the same way.
    state.notifierID = Zotero.Notifier.registerObserver(
      {
        notify(event, type, ids, extraData) {
          if (event !== "select" || type !== "tab") return;
          if (extraData?.[ids[0]]?.type !== TAB_TYPE || tabs.selectedID !== ids[0]) return;
          win.setTimeout(() => {
            doc.getElementById("zotero-context-splitter")?.setAttribute("hidden", true);
            doc.getElementById("zotero-context-pane")?.setAttribute("collapsed", true);
            const sidenav = doc.getElementById("zotero-context-pane-sidenav");
            if (sidenav) sidenav.hidden = true;
          }, 0);
        },
      },
      ["tab"],
      "zotero-annotable-tabs",
    );
  }

  const makeItem = (id, label, onCommand) => {
    const mi = doc.createXULElement("menuitem");
    mi.id = id;
    mi.setAttribute("label", label);
    mi.addEventListener("command", onCommand);
    return mi;
  };

  const toolsPopup = doc.getElementById("menu_ToolsPopup");
  if (toolsPopup) {
    const sep = doc.createXULElement("menuseparator");
    sep.id = "annotable-tools-sep";
    const a = makeItem("annotable-tools-open", "Annotation Browser", () => openTab(win));
    const b = makeItem("annotable-tools-open-window", "Annotation Browser (Window)", () =>
      openWindow(win),
    );
    toolsPopup.append(sep, a, b);
    state.elements.push(sep, a, b);
  }

  const itemMenu = doc.getElementById("zotero-itemmenu");
  if (itemMenu) {
    const sep = doc.createXULElement("menuseparator");
    sep.id = "annotable-itemmenu-sep";
    const mi = makeItem("annotable-itemmenu-open", "Show Annotations", () => {
      const ids = selectedTopLevelIDs(win);
      openTab(win, ids.length ? ids : null);
    });
    itemMenu.append(sep, mi);
    state.elements.push(sep, mi);
  }
}

function removeFromWindow(win) {
  const state = win[WIN_KEY];
  if (!state) return;
  const tabs = win.Zotero_Tabs;
  if (tabs) {
    if (state.tabID) {
      try {
        tabs.close(state.tabID);
      } catch (e) {
        Zotero.logError(e);
      }
    }
    if (state.notifierID) Zotero.Notifier.unregisterObserver(state.notifierID);
    if (state.origGetState) tabs.getState = state.origGetState;
    if (tabs.tabHooks?.restoreState) delete tabs.tabHooks.restoreState[TAB_TYPE];
  }
  for (const el of state.elements) el.remove();
  delete win[WIN_KEY];
}

function selectedTopLevelIDs(win) {
  const items = win.ZoteroPane?.getSelectedItems() || [];
  const ids = new Set();
  for (const item of items) {
    const top = item.isTopLevelItem() ? item : item.topLevelItem || item.parentItem;
    if (top) ids.add(top.id);
  }
  return [...ids];
}

function openTab(win, itemIDs = null) {
  win = win || Zotero.getMainWindow();
  const state = win[WIN_KEY];
  const tabs = win.Zotero_Tabs;
  if (!state || !tabs) return openWindow(win, itemIDs);

  if (state.tabID && tabs._getTab(state.tabID)?.tab) {
    tabs.select(state.tabID);
    if (itemIDs) {
      const frame = win.document.getElementById(state.tabID)?.querySelector("iframe");
      frame?.contentWindow?.Annotable?.setItemFilter(itemIDs);
    }
    return;
  }

  const { id, container } = tabs.add({
    type: TAB_TYPE,
    title: "Annotations",
    data: {},
    select: true,
    onClose: () => {
      state.tabID = null;
    },
  });
  state.tabID = id;
  container.style.display = "flex";
  container.style.flexDirection = "column";
  const iframe = win.document.createElementNS(HTML_NS, "iframe");
  iframe.setAttribute("src", PAGE_URL + (itemIDs ? `?items=${itemIDs.join(",")}` : ""));
  iframe.style.cssText = "border:0;flex:1 1 auto;width:100%;height:100%;min-height:0;";
  container.appendChild(iframe);
}

function openWindow(win, itemIDs = null) {
  win = win || Zotero.getMainWindow();
  const existing = Services.wm.getMostRecentWindow("zotero:annotable");
  if (existing) {
    existing.focus();
    if (itemIDs) existing.Annotable?.setItemFilter(itemIDs);
    return;
  }
  win.openDialog(
    PAGE_URL + (itemIDs ? `?items=${itemIDs.join(",")}` : ""),
    "zotero-annotable-window",
    "chrome,resizable,centerscreen,dialog=no,width=1200,height=850",
  );
}
