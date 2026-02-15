import type { CdpClient } from "./cdp-client.js";

/**
 * Navigate to a URL and wait for the page load event.
 */
export async function navigate(cdp: CdpClient, url: string, sessionId?: string): Promise<void> {
  await cdp.send("Page.enable", undefined, sessionId);

  const loaded = new Promise<void>((resolve) => {
    const handler = () => {
      cdp.off("Page.loadEventFired", handler);
      resolve();
    };
    cdp.on("Page.loadEventFired", handler);
  });

  const result = (await cdp.send("Page.navigate", { url }, sessionId)) as {
    errorText?: string;
  };
  if (result?.errorText) {
    throw new Error(`Navigation failed: ${result.errorText}`);
  }

  await loaded;

  // Bring the tab to the foreground so it's visible in noVNC/display
  await cdp.send("Page.bringToFront", undefined, sessionId);
}

/**
 * Wait until no network requests have been in-flight for `idleMs` milliseconds.
 */
export async function waitForNetworkIdle(
  cdp: CdpClient,
  idleMs = 500,
  timeoutMs = 30000,
  sessionId?: string,
): Promise<void> {
  await cdp.send("Network.enable", undefined, sessionId);

  let inflight = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return new Promise<void>((resolve, _reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(); // resolve on timeout rather than reject — page is likely usable
    }, timeoutMs);

    const checkIdle = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (inflight <= 0) {
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, idleMs);
      }
    };

    const onRequest = () => {
      inflight++;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onFinish = () => {
      inflight = Math.max(0, inflight - 1);
      checkIdle();
    };

    const cleanup = () => {
      clearTimeout(timeout);
      if (timer) {
        clearTimeout(timer);
      }
      cdp.off("Network.requestWillBeSent", onRequest);
      cdp.off("Network.loadingFinished", onFinish);
      cdp.off("Network.loadingFailed", onFinish);
    };

    cdp.on("Network.requestWillBeSent", onRequest);
    cdp.on("Network.loadingFinished", onFinish);
    cdp.on("Network.loadingFailed", onFinish);

    checkIdle();
  });
}

/**
 * Navigate back in history.
 */
export async function goBack(cdp: CdpClient, sessionId?: string): Promise<void> {
  const history = (await cdp.send("Page.getNavigationHistory", undefined, sessionId)) as {
    currentIndex?: number;
    entries?: Array<{ id: number }>;
  };

  const idx = history?.currentIndex ?? 0;
  const entries = history?.entries ?? [];
  if (idx > 0 && entries[idx - 1]) {
    await cdp.send("Page.navigateToHistoryEntry", { entryId: entries[idx - 1].id }, sessionId);
  }
}

/**
 * Navigate forward in history.
 */
export async function goForward(cdp: CdpClient, sessionId?: string): Promise<void> {
  const history = (await cdp.send("Page.getNavigationHistory", undefined, sessionId)) as {
    currentIndex?: number;
    entries?: Array<{ id: number }>;
  };

  const idx = history?.currentIndex ?? 0;
  const entries = history?.entries ?? [];
  if (idx < entries.length - 1 && entries[idx + 1]) {
    await cdp.send("Page.navigateToHistoryEntry", { entryId: entries[idx + 1].id }, sessionId);
  }
}

/**
 * Reload the current page.
 */
export async function reload(cdp: CdpClient, sessionId?: string): Promise<void> {
  await cdp.send("Page.enable", undefined, sessionId);

  const loaded = new Promise<void>((resolve) => {
    const handler = () => {
      cdp.off("Page.loadEventFired", handler);
      resolve();
    };
    cdp.on("Page.loadEventFired", handler);
  });

  await cdp.send("Page.reload", undefined, sessionId);
  await loaded;
}
