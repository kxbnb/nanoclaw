import type { CdpClient } from "./cdp-client.js";

export type TabInfo = {
  tabId: string;
  sessionId: string;
  url: string;
  title: string;
};

export interface TabManager {
  createTab(url?: string): Promise<string>;
  attach(targetId: string): Promise<string>;
  closeTab(tabId: string): Promise<void>;
  getTab(tabId: string): TabInfo | undefined;
  listTabs(): TabInfo[];
  dispose(): void;
}

export function createTabManager(cdp: CdpClient): TabManager {
  const tabs = new Map<string, TabInfo>();

  const onTargetDestroyed = (params: unknown) => {
    const { targetId } = params as { targetId?: string };
    if (targetId) {
      tabs.delete(targetId);
    }
  };

  const onTargetInfoChanged = (params: unknown) => {
    const { targetInfo } = params as {
      targetInfo?: { targetId?: string; url?: string; title?: string };
    };
    if (!targetInfo?.targetId) {
      return;
    }
    const tab = tabs.get(targetInfo.targetId);
    if (tab) {
      if (targetInfo.url !== undefined) {
        tab.url = targetInfo.url;
      }
      if (targetInfo.title !== undefined) {
        tab.title = targetInfo.title;
      }
    }
  };

  cdp.on("Target.targetDestroyed", onTargetDestroyed);
  cdp.on("Target.targetInfoChanged", onTargetInfoChanged);

  return {
    async createTab(url?: string): Promise<string> {
      const result = (await cdp.send("Target.createTarget", {
        url: url ?? "about:blank",
      })) as { targetId?: string };
      const targetId = result?.targetId;
      if (!targetId) {
        throw new Error("Target.createTarget returned no targetId");
      }

      await this.attach(targetId);
      const tab = tabs.get(targetId);
      if (tab) {
        tab.url = url ?? "about:blank";
      }
      return targetId;
    },

    async attach(targetId: string): Promise<string> {
      const result = (await cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId?: string };
      const sessionId = result?.sessionId;
      if (!sessionId) {
        throw new Error("Target.attachToTarget returned no sessionId");
      }

      tabs.set(targetId, { tabId: targetId, sessionId, url: "", title: "" });
      return sessionId;
    },

    async closeTab(tabId: string): Promise<void> {
      await cdp.send("Target.closeTarget", { targetId: tabId });
      tabs.delete(tabId);
    },

    getTab(tabId: string): TabInfo | undefined {
      return tabs.get(tabId);
    },

    listTabs(): TabInfo[] {
      return [...tabs.values()];
    },

    dispose() {
      cdp.off("Target.targetDestroyed", onTargetDestroyed);
      cdp.off("Target.targetInfoChanged", onTargetInfoChanged);
    },
  };
}
