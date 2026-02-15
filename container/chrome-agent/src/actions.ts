import type { CdpClient } from "./cdp-client.js";
import { parseRef, type RefMap } from "./accessibility.js";

/**
 * Resolve a ref string (e.g. "@e1") to a backendDOMNodeId.
 */
function resolveRef(ref: string, refs: RefMap): number {
  const parsed = parseRef(ref);
  if (!parsed) {
    throw new Error(`Invalid ref: "${ref}"`);
  }
  const nodeId = refs.get(parsed);
  if (nodeId === undefined) {
    throw new Error(`Ref "${ref}" not found — run snapshot() first`);
  }
  return nodeId;
}

/**
 * Get the center coordinates of a node via DOM.getContentQuads.
 */
async function getClickPoint(
  cdp: CdpClient,
  backendNodeId: number,
  sessionId?: string,
): Promise<{ x: number; y: number }> {
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId);

  const result = (await cdp.send("DOM.getContentQuads", { backendNodeId }, sessionId)) as {
    quads?: number[][];
  };
  const quads = result?.quads;
  if (!quads?.length || !quads[0]?.length) {
    throw new Error("Could not get element position (no quads returned)");
  }

  // First quad: [x1,y1, x2,y2, x3,y3, x4,y4] — compute center
  const q = quads[0];
  const x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
  const y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
  return { x, y };
}

/**
 * Click an element identified by ref.
 */
export async function clickRef(
  cdp: CdpClient,
  ref: string,
  refs: RefMap,
  sessionId?: string,
): Promise<void> {
  const backendNodeId = resolveRef(ref, refs);
  const { x, y } = await getClickPoint(cdp, backendNodeId, sessionId);

  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", clickCount: 1 },
    sessionId,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
    sessionId,
  );
}

/**
 * Type text into a focused element identified by ref.
 */
export async function typeIntoRef(
  cdp: CdpClient,
  ref: string,
  text: string,
  refs: RefMap,
  sessionId?: string,
): Promise<void> {
  const backendNodeId = resolveRef(ref, refs);

  const resolved = (await cdp.send("DOM.resolveNode", { backendNodeId }, sessionId)) as {
    object?: { objectId?: string };
  };
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new Error("Could not resolve node to JS object");
  }

  await cdp.send("DOM.focus", { backendNodeId }, sessionId);

  // Clear existing value
  await cdp.send(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function() { this.value = ''; this.dispatchEvent(new Event('input', {bubbles: true})); }`,
    },
    sessionId,
  );

  await cdp.send("Input.insertText", { text }, sessionId);
}

/**
 * Select option(s) in a <select> element identified by ref.
 */
export async function selectOption(
  cdp: CdpClient,
  ref: string,
  values: string[],
  refs: RefMap,
  sessionId?: string,
): Promise<void> {
  const backendNodeId = resolveRef(ref, refs);

  const resolved = (await cdp.send("DOM.resolveNode", { backendNodeId }, sessionId)) as {
    object?: { objectId?: string };
  };
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new Error("Could not resolve node to JS object");
  }

  await cdp.send(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function(vals) {
        const values = JSON.parse(vals);
        for (const opt of this.options) {
          opt.selected = values.includes(opt.value);
        }
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value: JSON.stringify(values) }],
    },
    sessionId,
  );
}

/**
 * Set a checkbox/radio to a specific checked state.
 * Clicks the element if its current state doesn't match.
 */
export async function checkRef(
  cdp: CdpClient,
  ref: string,
  checked: boolean,
  refs: RefMap,
  sessionId?: string,
): Promise<void> {
  const backendNodeId = resolveRef(ref, refs);

  const resolved = (await cdp.send("DOM.resolveNode", { backendNodeId }, sessionId)) as {
    object?: { objectId?: string };
  };
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new Error("Could not resolve node to JS object");
  }

  const evalResult = (await cdp.send(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function() { return this.checked; }`,
      returnByValue: true,
    },
    sessionId,
  )) as { result?: { value?: boolean } };

  const currentChecked = evalResult?.result?.value ?? false;
  if (currentChecked !== checked) {
    await clickRef(cdp, ref, refs, sessionId);
  }
}
