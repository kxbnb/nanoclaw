import type { CdpClient } from "./cdp-client.js";

export type ScreenshotOptions = {
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number; // jpeg only (0-100)
};

/**
 * Capture a screenshot via CDP.
 */
export async function captureScreenshot(
  cdp: CdpClient,
  opts?: ScreenshotOptions,
  sessionId?: string,
): Promise<Buffer> {
  await cdp.send("Page.enable", undefined, sessionId);

  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;

  if (opts?.fullPage) {
    const metrics = (await cdp.send("Page.getLayoutMetrics", undefined, sessionId)) as {
      cssContentSize?: { width?: number; height?: number };
      contentSize?: { width?: number; height?: number };
    };
    const size = metrics?.cssContentSize ?? metrics?.contentSize;
    const width = Number(size?.width ?? 0);
    const height = Number(size?.height ?? 0);
    if (width > 0 && height > 0) {
      clip = { x: 0, y: 0, width, height, scale: 1 };
    }
  }

  const format = opts?.format ?? "png";
  const quality =
    format === "jpeg" ? Math.max(0, Math.min(100, Math.round(opts?.quality ?? 85))) : undefined;

  const result = (await cdp.send(
    "Page.captureScreenshot",
    {
      format,
      ...(quality !== undefined ? { quality } : {}),
      fromSurface: true,
      captureBeyondViewport: true,
      ...(clip ? { clip } : {}),
    },
    sessionId,
  )) as { data?: string };

  const base64 = result?.data;
  if (!base64) {
    throw new Error("Screenshot failed: missing data");
  }
  return Buffer.from(base64, "base64");
}
