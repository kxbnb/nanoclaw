import { snapshot as axSnapshot, type RefMap } from "./accessibility.js";
import { clickRef, typeIntoRef, selectOption, checkRef } from "./actions.js";
import { connectCdp, type CdpClient } from "./cdp-client.js";
import { getCookies, exportCookies, importCookies, type CdpCookie } from "./cookies.js";
import { navigate, waitForNetworkIdle, goBack, goForward, reload } from "./navigation.js";
import { captureScreenshot, type ScreenshotOptions } from "./screenshot.js";
import { createTabManager, type TabManager, type TabInfo } from "./tab-manager.js";

export { type CdpClient } from "./cdp-client.js";
export { type TabInfo } from "./tab-manager.js";
export { type RefMap, type AriaSnapshotNode, type RawAXNode } from "./accessibility.js";
export { type ScreenshotOptions } from "./screenshot.js";
export { type CdpCookie } from "./cookies.js";

export class ChromeAgent {
  private cdp: CdpClient;
  private tabs: TabManager;
  private currentSessionId: string | undefined;
  private currentTabId: string | undefined;
  private refs: RefMap = new Map();

  private constructor(cdp: CdpClient) {
    this.cdp = cdp;
    this.tabs = createTabManager(cdp);
  }

  /**
   * Connect to a Chrome instance via CDP.
   * Accepts an HTTP URL (e.g. http://localhost:9222) or a ws:// URL.
   */
  static async connect(cdpUrl: string): Promise<ChromeAgent> {
    const cdp = await connectCdp(cdpUrl);

    // Enable target discovery
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    const agent = new ChromeAgent(cdp);

    // Attach to the first available page target
    const targets = (await cdp.send("Target.getTargets")) as {
      targetInfos?: Array<{ targetId: string; type: string; url: string }>;
    };
    const page = targets?.targetInfos?.find((t) => t.type === "page");
    if (page) {
      const sessionId = await agent.tabs.attach(page.targetId);
      agent.currentTabId = page.targetId;
      agent.currentSessionId = sessionId;
    }

    return agent;
  }

  /** Navigate the current tab to a URL. */
  async navigate(url: string): Promise<void> {
    await navigate(this.cdp, url, this.currentSessionId);
    this.refs.clear();
  }

  /** Get an LLM-readable accessibility snapshot with refs. */
  async snapshot(): Promise<string> {
    const result = await axSnapshot(this.cdp, this.currentSessionId);
    this.refs = result.refs;
    return result.text;
  }

  /** Click an element by ref (e.g. "@e1"). */
  async click(ref: string): Promise<void> {
    await clickRef(this.cdp, ref, this.refs, this.currentSessionId);
  }

  /** Type text into an element by ref. */
  async type(ref: string, text: string): Promise<void> {
    await typeIntoRef(this.cdp, ref, text, this.refs, this.currentSessionId);
  }

  /** Select option(s) in a <select> element by ref. */
  async select(ref: string, values: string[]): Promise<void> {
    await selectOption(this.cdp, ref, values, this.refs, this.currentSessionId);
  }

  /** Set checkbox/radio checked state by ref. */
  async check(ref: string, checked: boolean): Promise<void> {
    await checkRef(this.cdp, ref, checked, this.refs, this.currentSessionId);
  }

  /** Take a screenshot. Returns a PNG/JPEG buffer. */
  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    return captureScreenshot(this.cdp, opts, this.currentSessionId);
  }

  /** Create a new tab, optionally navigating to a URL. Returns the tab ID. */
  async newTab(url?: string): Promise<string> {
    const tabId = await this.tabs.createTab(url);
    const tab = this.tabs.getTab(tabId);
    if (tab) {
      this.currentTabId = tabId;
      this.currentSessionId = tab.sessionId;
      this.refs.clear();
    }
    return tabId;
  }

  /** Switch to an existing tab by ID. */
  async switchTab(tabId: string): Promise<void> {
    const tab = this.tabs.getTab(tabId);
    if (!tab) {
      throw new Error(`Tab "${tabId}" not found`);
    }
    this.currentTabId = tabId;
    this.currentSessionId = tab.sessionId;
    this.refs.clear();
  }

  /** Close a tab (defaults to current tab). */
  async closeTab(tabId?: string): Promise<void> {
    const target = tabId ?? this.currentTabId;
    if (!target) {
      throw new Error("No tab to close");
    }
    await this.tabs.closeTab(target);
    if (target === this.currentTabId) {
      this.currentTabId = undefined;
      this.currentSessionId = undefined;
      this.refs.clear();
    }
  }

  /** List all tracked tabs. */
  listTabs(): TabInfo[] {
    return this.tabs.listTabs();
  }

  /** Get cookies, optionally filtered by URLs. */
  async getCookies(urls?: string[]): Promise<CdpCookie[]> {
    return getCookies(this.cdp, urls, this.currentSessionId);
  }

  /** Export all cookies as JSON. */
  async exportCookies(): Promise<string> {
    return exportCookies(this.cdp, this.currentSessionId);
  }

  /** Import cookies from JSON. */
  async importCookies(json: string): Promise<void> {
    return importCookies(this.cdp, json, this.currentSessionId);
  }

  /** Go back in history. */
  async back(): Promise<void> {
    await goBack(this.cdp, this.currentSessionId);
    this.refs.clear();
  }

  /** Go forward in history. */
  async forward(): Promise<void> {
    await goForward(this.cdp, this.currentSessionId);
    this.refs.clear();
  }

  /** Reload the current page. */
  async reload(): Promise<void> {
    await reload(this.cdp, this.currentSessionId);
    this.refs.clear();
  }

  /** Wait for network to be idle. */
  async waitForNetworkIdle(idleMs?: number, timeoutMs?: number): Promise<void> {
    await waitForNetworkIdle(this.cdp, idleMs, timeoutMs, this.currentSessionId);
  }

  /** Close the CDP connection. */
  async close(): Promise<void> {
    this.tabs.dispose();
    this.cdp.close();
  }
}
