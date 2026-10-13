import { config } from "../package.json";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { openAnnotationsTab, registerAnnotationsTab, ensureViewMenuItem, removeViewMenuItem } from "./modules/annotations";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  initLocale();
  Zotero.PreferencePanes.register(
    {
      pluginID: config.addonID,
      src: rootURI + "chrome/content/preferences.xhtml",
      label: "Annotable",
      image: `chrome://${config.addonRef}/content/icons/favicon.png`,
      // defaultXUL: true,
    }
  );
  const wins = (Zotero.getMainWindows?.() || [window]) as unknown as _ZoteroTypes.MainWindow[];
  for (const w of wins) {
    await onMainWindowLoad(w);
    openAnnotationsTab(w);
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  registerAnnotationsTab(win);
  ensureViewMenuItem(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  removeViewMenuItem(win as _ZoteroTypes.MainWindow);
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  if (addon.data.notifierID) {
    Zotero.Notifier.unregisterObserver(addon.data.notifierID);
  }
  // Remove addon object
  addon.data.alive = false;
  delete (Zotero as any)[config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this funcion clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
