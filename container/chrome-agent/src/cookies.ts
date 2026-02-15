import type { CdpClient } from "./cdp-client.js";

export type CdpCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
};

/**
 * Get cookies, optionally filtered by URLs.
 */
export async function getCookies(
  cdp: CdpClient,
  urls?: string[],
  sessionId?: string,
): Promise<CdpCookie[]> {
  const params: Record<string, unknown> = {};
  if (urls?.length) {
    params.urls = urls;
  }
  const result = (await cdp.send("Network.getCookies", params, sessionId)) as {
    cookies?: CdpCookie[];
  };
  return result?.cookies ?? [];
}

/**
 * Set a single cookie.
 */
export async function setCookie(
  cdp: CdpClient,
  cookie: Partial<CdpCookie> & { name: string; value: string },
  sessionId?: string,
): Promise<void> {
  const result = (await cdp.send(
    "Network.setCookie",
    cookie as Record<string, unknown>,
    sessionId,
  )) as { success?: boolean };
  if (!result?.success) {
    throw new Error(`Failed to set cookie "${cookie.name}"`);
  }
}

/**
 * Export all cookies as a JSON-serializable array.
 */
export async function exportCookies(cdp: CdpClient, sessionId?: string): Promise<string> {
  const cookies = await getCookies(cdp, undefined, sessionId);
  return JSON.stringify(cookies, null, 2);
}

/**
 * Import cookies from a JSON string (as produced by exportCookies).
 */
export async function importCookies(
  cdp: CdpClient,
  json: string,
  sessionId?: string,
): Promise<void> {
  const cookies = JSON.parse(json) as CdpCookie[];
  for (const cookie of cookies) {
    await setCookie(cdp, cookie, sessionId);
  }
}
