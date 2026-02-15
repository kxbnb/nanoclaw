import type { CdpClient } from "./cdp-client.js";

// --- Types ported from openclaw/src/browser/cdp.ts ---

export type RawAXNode = {
  nodeId?: string;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  childIds?: string[];
  backendDOMNodeId?: number;
};

export type AriaSnapshotNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  depth: number;
};

// --- Role sets ported from openclaw/src/browser/pw-role-snapshot.ts ---

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

export const CONTENT_ROLES = new Set([
  "heading",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "listitem",
  "article",
  "region",
  "main",
  "navigation",
]);

const STRUCTURAL_ROLES = new Set([
  "generic",
  "group",
  "list",
  "table",
  "row",
  "rowgroup",
  "grid",
  "treegrid",
  "menu",
  "menubar",
  "toolbar",
  "tablist",
  "tree",
  "directory",
  "document",
  "application",
  "presentation",
  "none",
]);

// --- Ref map: ref string -> backendDOMNodeId ---

export type RefMap = Map<string, number>;

// --- Helpers ported from openclaw/src/browser/cdp.ts ---

function axValue(v: unknown): string {
  if (!v || typeof v !== "object") {
    return "";
  }
  const value = (v as { value?: unknown }).value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/**
 * Parse raw CDP AX nodes into a flat AriaSnapshotNode array via DFS.
 */
export function formatAriaSnapshot(nodes: RawAXNode[], limit: number): AriaSnapshotNode[] {
  const byId = new Map<string, RawAXNode>();
  for (const n of nodes) {
    if (n.nodeId) {
      byId.set(n.nodeId, n);
    }
  }

  // Find root: a node not referenced as a child by any other node.
  const referenced = new Set<string>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) {
      referenced.add(c);
    }
  }
  const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) ?? nodes[0];
  if (!root?.nodeId) {
    return [];
  }

  const out: AriaSnapshotNode[] = [];
  const stack: Array<{ id: string; depth: number }> = [{ id: root.nodeId, depth: 0 }];

  while (stack.length && out.length < limit) {
    const popped = stack.pop();
    if (!popped) {
      break;
    }
    const { id, depth } = popped;
    const n = byId.get(id);
    if (!n) {
      continue;
    }

    const role = axValue(n.role);
    const name = axValue(n.name);
    const value = axValue(n.value);
    const description = axValue(n.description);
    const ref = `ax${out.length + 1}`;

    out.push({
      ref,
      role: role || "unknown",
      name: name || "",
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(typeof n.backendDOMNodeId === "number" ? { backendDOMNodeId: n.backendDOMNodeId } : {}),
      depth,
    });

    const children = (n.childIds ?? []).filter((c) => byId.has(c));
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) {
        stack.push({ id: child, depth: depth + 1 });
      }
    }
  }

  return out;
}

// --- Snapshot rendering with @ref system ---

/**
 * Fetch the full AX tree via CDP and render it as an LLM-readable text snapshot
 * with [@eN] refs on interactive elements.
 *
 * Returns the text snapshot and a RefMap (ref -> backendDOMNodeId) for actions.
 */
export async function snapshot(
  cdp: CdpClient,
  sessionId?: string,
  opts?: { limit?: number },
): Promise<{ text: string; refs: RefMap }> {
  const limit = Math.max(1, Math.min(2000, Math.floor(opts?.limit ?? 500)));

  await cdp.send("Accessibility.enable", undefined, sessionId);
  const res = (await cdp.send("Accessibility.getFullAXTree", undefined, sessionId)) as {
    nodes?: RawAXNode[];
  };
  const rawNodes = Array.isArray(res?.nodes) ? res.nodes : [];
  const axNodes = formatAriaSnapshot(rawNodes, limit);

  return buildSnapshot(axNodes);
}

/**
 * Build an LLM-readable text snapshot from AriaSnapshotNodes.
 * Interactive elements get [@eN] refs. Content elements with names also get refs.
 */
export function buildSnapshot(axNodes: AriaSnapshotNode[]): { text: string; refs: RefMap } {
  const refs: RefMap = new Map();
  const lines: string[] = [];
  let refCounter = 0;

  for (const node of axNodes) {
    const role = node.role.toLowerCase();
    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isContent = CONTENT_ROLES.has(role);
    const isStructural = STRUCTURAL_ROLES.has(role);

    // Skip unnamed structural nodes to keep output compact
    if (isStructural && !node.name) {
      continue;
    }
    // Skip unknown/ignored roles with no name
    if (role === "unknown" && !node.name) {
      continue;
    }
    if (role === "none" || role === "presentation") {
      continue;
    }
    // Skip StaticText — its content is usually captured by parent's name
    if (role === "statictext" || role === "InlineTextBox") {
      continue;
    }

    const indent = "  ".repeat(node.depth);
    let line = `${indent}- ${role}`;
    if (node.name) {
      line += ` "${node.name}"`;
    }
    if (node.value) {
      line += `: "${node.value}"`;
    }

    const shouldHaveRef = isInteractive || (isContent && !!node.name);
    if (shouldHaveRef && typeof node.backendDOMNodeId === "number") {
      refCounter++;
      const ref = `e${refCounter}`;
      refs.set(ref, node.backendDOMNodeId);
      line += ` [@${ref}]`;
    }

    lines.push(line);
  }

  return { text: lines.join("\n") || "(empty page)", refs };
}

/**
 * Parse a ref string like "@e1" or "e1" into the canonical "e1" form.
 */
export function parseRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return /^e\d+$/.test(normalized) ? normalized : null;
}
