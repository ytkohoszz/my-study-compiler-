import { setIcon } from "obsidian";
import type { DeadlineTone, StudyNoteItem } from "./types";
import {
  ScanResult,
  byName,
  collectDescendants,
  formatDeadlineBadge,
  getDeadlineTone,
  getWorkMeta,
} from "./scanner";
import { prefersReducedMotion } from "./motion";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_W = 176;
const NODE_H = 34;
const GAP_X = 64;
const ROW_H = 46;
const COL_W = NODE_W + GAP_X;
const MIN_K = 0.1;
const MAX_K = 2.5;
const DOUBLE_TAP_MS = 320;
const DRAG_THRESHOLD = 4;
const LABEL_MAX_CHARS = 21;

export interface GraphCallbacks {
  onOpen: (path: string) => void;
  onFocus: (path: string) => void;
  onOpenSchema: (path: string) => void;
}

interface LayoutNode {
  item: StudyNoteItem;
  depth: number;
  x: number;
  y: number;
  children: LayoutNode[];
  hiddenCount: number;
  hasKids: boolean;
}

interface EdgeRef {
  from: string;
  to: string;
  el: SVGPathElement;
}

interface Point {
  x: number;
  y: number;
}

interface Bounds {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  cls = ""
): SVGElementTagNameMap[K] {
  const el = doc.createElementNS(SVG_NS, tag);
  if (cls) el.setAttribute("class", cls);
  return el;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export class ProjectGraphView {
  private container: HTMLElement;
  private callbacks: GraphCallbacks;
  private doc: Document;
  private svg: SVGSVGElement;
  private viewport: SVGGElement;
  private edgesLayer: SVGGElement;
  private nodesLayer: SVGGElement;
  private statEl: HTMLElement;
  private infoEl: HTMLElement;
  private infoTitleEl: HTMLElement;
  private infoSubEl: HTMLElement;
  private schemaBtn: HTMLButtonElement;
  private focusBtn: HTMLButtonElement;
  private toggleAllBtn: HTMLButtonElement;

  private scan: ScanResult | null = null;
  private branchRoot: StudyNoteItem | null = null;
  private fresh: Set<string> = new Set();
  private collapsed = new Set<string>();
  private selectedPath: string | null = null;

  private placed: LayoutNode[] = [];
  private nodeByPath = new Map<string, LayoutNode>();
  private parentOf = new Map<string, string>();
  private nodeEls = new Map<string, SVGGElement>();
  private edgeRefs: EdgeRef[] = [];
  private bounds: Bounds = { minX: 0, minY: 0, w: 1, h: 1 };

  private tx = 0;
  private ty = 0;
  private k = 1;
  private pendingFit = false;
  private animTimer: number | null = null;

  private pointers = new Map<number, Point>();
  private downPos: Point = { x: 0, y: 0 };
  private downTarget: Element | null = null;
  private moved = false;
  private lastTapPath: string | null = null;
  private lastTapAt = 0;
  private listening = false;

  constructor(container: HTMLElement, callbacks: GraphCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.doc = container.ownerDocument;
    container.empty();

    this.svg = svgEl(this.doc, "svg", "my-sc-graph-svg");
    this.viewport = svgEl(this.doc, "g", "my-sc-graph-viewport");
    this.edgesLayer = svgEl(this.doc, "g", "my-sc-graph-edges");
    this.nodesLayer = svgEl(this.doc, "g", "my-sc-graph-nodes");
    this.viewport.appendChild(this.edgesLayer);
    this.viewport.appendChild(this.nodesLayer);
    this.svg.appendChild(this.viewport);
    container.appendChild(this.svg);

    const controls = container.createDiv("my-sc-graph-controls");
    const addCtrl = (icon: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = controls.createEl("button", {
        cls: "my-sc-graph-ctrl",
        attr: { type: "button", title, "aria-label": title },
      });
      setIcon(b, icon);
      b.onclick = fn;
      return b;
    };
    addCtrl("plus", "Приблизить", () => this.zoomByCenter(1.3));
    addCtrl("minus", "Отдалить", () => this.zoomByCenter(1 / 1.3));
    addCtrl("maximize", "Показать всё", () => this.fit(true));
    this.toggleAllBtn = addCtrl("chevrons-down-up", "Свернуть ветки", () => {
      if (this.collapsed.size > 0) this.collapsed.clear();
      else this.collapseDeep();
      this.rebuild();
      this.fit(true);
    });

    this.infoEl = container.createDiv("my-sc-graph-info is-hidden");
    const infoText = this.infoEl.createDiv("my-sc-graph-info-text");
    this.infoTitleEl = infoText.createDiv("my-sc-graph-info-title");
    this.infoSubEl = infoText.createDiv("my-sc-graph-info-sub");
    const infoBtns = this.infoEl.createDiv("my-sc-graph-info-btns");

    this.schemaBtn = infoBtns.createEl("button", {
      cls: "my-sc-chip-btn is-schema-btn",
      text: "☊ Схема",
      attr: { type: "button", title: "Открыть интерактивную схему этого узла" },
    });
    this.schemaBtn.onclick = () => {
      if (this.selectedPath) this.callbacks.onOpenSchema(this.selectedPath);
    };

    const openBtn = infoBtns.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "Открыть",
      attr: { type: "button" },
    });
    openBtn.onclick = () => {
      if (this.selectedPath) this.callbacks.onOpen(this.selectedPath);
    };
    this.focusBtn = infoBtns.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "Фокус",
      attr: { type: "button", title: "Показать только эту ветку" },
    });
    this.focusBtn.onclick = () => {
      if (this.selectedPath) this.callbacks.onFocus(this.selectedPath);
    };
    const clearBtn = infoBtns.createEl("button", {
      cls: "my-sc-icon-btn",
      attr: { type: "button", title: "Снять выделение", "aria-label": "Снять выделение" },
    });
    setIcon(clearBtn, "x");
    clearBtn.onclick = () => this.select(null);

    const footer = container.createDiv("my-sc-graph-footer");
    this.statEl = footer.createSpan("my-sc-graph-stat");

    this.svg.addEventListener("pointerdown", this.onPointerDown);
    container.addEventListener("wheel", this.onWheel, { passive: false });
  }

  update(
    scan: ScanResult,
    branchRoot: StudyNoteItem,
    resetView: boolean,
    fresh: ReadonlySet<string>
  ): void {
    this.scan = scan;
    this.branchRoot = branchRoot;
    this.fresh = new Set(fresh);
    if (resetView) {
      this.collapsed.clear();
      this.selectedPath = null;
      this.pendingFit = true;
    }
    this.rebuild();
    if (this.pendingFit) {
      window.requestAnimationFrame(() => this.tryFit());
    }
  }

  clearFresh(): void {
    this.fresh.clear();
    this.nodesLayer
      .querySelectorAll(".is-new")
      .forEach((el) => el.classList.remove("is-new"));
  }

  destroy(): void {
    this.detachDocListeners();
    this.pointers.clear();
    if (this.animTimer !== null) {
      window.clearTimeout(this.animTimer);
      this.animTimer = null;
    }
    this.svg.removeEventListener("pointerdown", this.onPointerDown);
    this.container.removeEventListener("wheel", this.onWheel);
    this.container.empty();
  }

  private rebuild(): void {
    const scan = this.scan;
    const root = this.branchRoot;
    if (!scan || !root) return;

    const visited = new Set<string>([root.path]);
    const extra: Array<[string, string]> = [];

    const make = (item: StudyNoteItem, depth: number): LayoutNode => {
      const kidPaths = scan.childrenOf.get(item.path) ?? [];
      const node: LayoutNode = {
        item,
        depth,
        x: 0,
        y: 0,
        children: [],
        hiddenCount: 0,
        hasKids: kidPaths.length > 0,
      };
      if (!node.hasKids) return node;
      if (this.collapsed.has(item.path)) {
        node.hiddenCount = collectDescendants(item.path, scan).size;
        return node;
      }
      const kids = kidPaths
        .map((p) => scan.byPath.get(p))
        .filter((x): x is StudyNoteItem => x !== undefined)
        .sort(byName);
      for (const kid of kids) {
        if (visited.has(kid.path)) {
          extra.push([item.path, kid.path]);
          continue;
        }
        visited.add(kid.path);
        node.children.push(make(kid, depth + 1));
      }
      return node;
    };

    const tree = make(root, 0);

    let leafIndex = 0;
    const place = (n: LayoutNode) => {
      n.x = n.depth * COL_W;
      if (n.children.length === 0) {
        n.y = leafIndex * ROW_H;
        leafIndex += 1;
        return;
      }
      for (const c of n.children) place(c);
      const first = n.children[0];
      const last = n.children[n.children.length - 1];
      n.y = first && last ? (first.y + last.y) / 2 : 0;
    };
    place(tree);

    this.placed = [];
    this.nodeByPath.clear();
    this.parentOf.clear();
    const stack: LayoutNode[] = [tree];
    while (stack.length > 0) {
      const n = stack.pop();
      if (!n) break;
      this.placed.push(n);
      this.nodeByPath.set(n.item.path, n);
      for (const c of n.children) {
        this.parentOf.set(c.item.path, n.item.path);
        stack.push(c);
      }
    }

    let maxX = 0;
    let maxY = 0;
    for (const n of this.placed) {
      maxX = Math.max(maxX, n.x + NODE_W + 24);
      maxY = Math.max(maxY, n.y + NODE_H);
    }
    this.bounds = { minX: 0, minY: 0, w: Math.max(maxX, 1), h: Math.max(maxY, 1) };

    this.renderLayers(extra);

    if (this.selectedPath && !this.nodeByPath.has(this.selectedPath)) {
      this.selectedPath = null;
    }
    this.applySelection();
    this.updateInfo();
    this.syncToggleAll();

    let hiddenTotal = 0;
    for (const n of this.placed) hiddenTotal += n.hiddenCount;
    this.statEl.setText(
      hiddenTotal > 0
        ? `Узлов: ${this.placed.length} · скрыто: ${hiddenTotal}`
        : `Узлов: ${this.placed.length}`
    );
  }

  private syncToggleAll(): void {
    const anyCollapsed = this.collapsed.size > 0;
    const title = anyCollapsed ? "Развернуть все ветки" : "Свернуть ветки";
    this.toggleAllBtn.empty();
    setIcon(this.toggleAllBtn, anyCollapsed ? "chevrons-up-down" : "chevrons-down-up");
    this.toggleAllBtn.setAttribute("title", title);
    this.toggleAllBtn.setAttribute("aria-label", title);
  }

  private renderLayers(extra: Array<[string, string]>): void {
    this.edgesLayer.replaceChildren();
    this.nodesLayer.replaceChildren();
    this.nodeEls.clear();
    this.edgeRefs = [];

    const addEdge = (fromPath: string, toPath: string, isExtra: boolean) => {
      const a = this.nodeByPath.get(fromPath);
      const b = this.nodeByPath.get(toPath);
      if (!a || !b) return;
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      const path = svgEl(
        this.doc,
        "path",
        "my-sc-gedge" + (isExtra ? " is-extra" : "")
      );
      path.setAttribute("d", `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
      this.edgesLayer.appendChild(path);
      this.edgeRefs.push({ from: fromPath, to: toPath, el: path });
    };

    for (const n of this.placed) {
      for (const c of n.children) addEdge(n.item.path, c.item.path, false);
    }
    for (const [from, to] of extra) addEdge(from, to, true);

    for (const n of this.placed) {
      const item = n.item;
      const meta = getWorkMeta(item.noteType, item.icon);
      const tone: DeadlineTone = getDeadlineTone(item);
      const hasMediaOrSchema =
        item.mediaItems.length > 0 || item.annotationCount > 0;
      const cls = [
        "my-sc-gnode",
        n.depth === 0 ? "is-root" : "",
        this.fresh.has(item.path) ? "is-new" : "",
        tone === "overdue" ? "is-overdue" : tone === "soon" ? "is-soon" : "",
      ]
        .filter(Boolean)
        .join(" ");

      const g = svgEl(this.doc, "g", cls);
      g.setAttribute("transform", `translate(${n.x} ${n.y})`);
      g.setAttribute("data-path", item.path);
      g.style.setProperty("--node-color", meta.color);

      const title = this.doc.createElementNS(SVG_NS, "title");
      title.textContent =
        `${item.name} · ${item.noteType || "без типа"}` +
        (item.deadline ? ` · ${formatDeadlineBadge(item)}` : "") +
        (hasMediaOrSchema
          ? ` · Иллюстраций: ${item.mediaItems.length}, аннотаций: ${item.annotationCount}`
          : "");
      g.appendChild(title);

      const body = svgEl(this.doc, "rect", "my-sc-gnode-body");
      body.setAttribute("width", String(NODE_W));
      body.setAttribute("height", String(NODE_H));
      body.setAttribute("rx", "8");
      g.appendChild(body);

      const stripe = svgEl(this.doc, "rect", "my-sc-gnode-stripe");
      stripe.setAttribute("width", "4");
      stripe.setAttribute("height", String(NODE_H));
      stripe.setAttribute("rx", "2");
      g.appendChild(stripe);

      const text = svgEl(this.doc, "text", "my-sc-gnode-label");
      text.setAttribute("x", "14");
      text.setAttribute("y", String(NODE_H / 2));
      text.setAttribute("dominant-baseline", "central");
      text.textContent = truncate(`${meta.icon} ${item.name}`, LABEL_MAX_CHARS);
      g.appendChild(text);

      if (hasMediaOrSchema) {
        const schemaDot = svgEl(this.doc, "circle", "my-sc-gnode-schema-dot");
        schemaDot.setAttribute("cx", String(NODE_W - 10));
        schemaDot.setAttribute("cy", String(NODE_H - 9));
        schemaDot.setAttribute("r", "3.5");
        g.appendChild(schemaDot);
      }

      if (tone === "overdue" || tone === "soon") {
        const dot = svgEl(this.doc, "circle", "my-sc-gnode-dot");
        dot.setAttribute("cx", String(NODE_W - 10));
        dot.setAttribute("cy", "9");
        dot.setAttribute("r", "3.5");
        g.appendChild(dot);
      }

      if (n.hasKids) {
        const isCollapsed = this.collapsed.has(item.path);
        const label = isCollapsed ? `+${n.hiddenCount}` : "−";
        const w = isCollapsed ? 14 + label.length * 6 : 20;
        const tg = svgEl(this.doc, "g", "my-sc-gtoggle" + (isCollapsed ? " is-collapsed" : ""));
        tg.setAttribute("data-toggle", item.path);
        const pill = svgEl(this.doc, "rect", "my-sc-gtoggle-pill");
        pill.setAttribute("x", String(NODE_W - w / 2));
        pill.setAttribute("y", String(NODE_H / 2 - 9));
        pill.setAttribute("width", String(w));
        pill.setAttribute("height", "18");
        pill.setAttribute("rx", "9");
        const t = svgEl(this.doc, "text", "my-sc-gtoggle-label");
        t.setAttribute("x", String(NODE_W));
        t.setAttribute("y", String(NODE_H / 2));
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "central");
        t.textContent = label;
        tg.appendChild(pill);
        tg.appendChild(t);
        g.appendChild(tg);
      }

      this.nodesLayer.appendChild(g);
      this.nodeEls.set(item.path, g);
    }
  }

  private collapseDeep(): void {
    for (const n of this.placed) {
      if (n.depth >= 1 && n.hasKids) this.collapsed.add(n.item.path);
    }
  }

  private toggleCollapse(path: string): void {
    if (this.collapsed.has(path)) this.collapsed.delete(path);
    else this.collapsed.add(path);
    this.rebuild();
  }

  private select(path: string | null): void {
    this.selectedPath = path;
    this.applySelection();
    this.updateInfo();
  }

  private lineageOf(path: string): Set<string> {
    const set = new Set<string>([path]);
    let cur = this.parentOf.get(path);
    while (cur !== undefined && !set.has(cur)) {
      set.add(cur);
      cur = this.parentOf.get(cur);
    }
    const node = this.nodeByPath.get(path);
    const stack: LayoutNode[] = node ? [...node.children] : [];
    while (stack.length > 0) {
      const n = stack.pop();
      if (!n) break;
      set.add(n.item.path);
      for (const c of n.children) stack.push(c);
    }
    return set;
  }

  private applySelection(): void {
    const sel = this.selectedPath;
    const lineage = sel ? this.lineageOf(sel) : null;
    for (const [path, el] of this.nodeEls) {
      el.classList.toggle("is-selected", path === sel);
      el.classList.toggle("is-dim", lineage !== null && !lineage.has(path));
    }
    for (const e of this.edgeRefs) {
      const lit = lineage !== null && lineage.has(e.from) && lineage.has(e.to);
      e.el.classList.toggle("is-lit", lit);
      e.el.classList.toggle("is-dim", lineage !== null && !lit);
    }
  }

  private updateInfo(): void {
    const node = this.selectedPath ? this.nodeByPath.get(this.selectedPath) : undefined;
    if (!node) {
      this.infoEl.addClass("is-hidden");
      return;
    }
    const it = node.item;
    const meta = getWorkMeta(it.noteType, it.icon);
    this.infoEl.removeClass("is-hidden");
    this.infoTitleEl.setText(`${meta.icon} ${it.name}`);
    const parts = [it.noteType || "без типа"];
    if (it.deadline) parts.push(formatDeadlineBadge(it));
    if (it.mediaItems.length > 0 || it.annotationCount > 0) {
      parts.push(
        `🖼 ${it.mediaItems.length}${it.annotationCount > 0 ? ` · ☊ ${it.annotationCount}` : ""}`
      );
    }
    this.infoSubEl.setText(parts.join(" · "));
    this.schemaBtn.setText(
      it.annotationCount > 0
        ? `☊ Схема (${it.annotationCount})`
        : it.mediaItems.length > 0
          ? `🖼 Схема (${it.mediaItems.length})`
          : "☊ Схема"
    );
    this.focusBtn.disabled = it.path === this.branchRoot?.path;
  }

  private tryFit(): void {
    if (this.svg.clientWidth <= 0 || this.svg.clientHeight <= 0) return;
    this.pendingFit = false;
    this.fit(false);
  }

  fit(animate: boolean): void {
    const w = this.svg.clientWidth;
    const h = this.svg.clientHeight;
    if (w <= 0 || h <= 0) return;
    const pad = 28;
    const b = this.bounds;
    const wFit = (w - pad * 2) / b.w;
    const hFit = (h - pad * 2) / b.h;
    let k = Math.min(wFit, hFit, 1.1);
    k = Math.max(k, Math.min(0.55, wFit));
    this.k = clamp(k, MIN_K, MAX_K);
    this.tx =
      b.w * this.k + pad * 2 <= w
        ? (w - b.w * this.k) / 2 - b.minX * this.k
        : pad - b.minX * this.k;
    this.ty =
      b.h * this.k + pad * 2 <= h
        ? (h - b.h * this.k) / 2 - b.minY * this.k
        : pad - b.minY * this.k;
    this.applyTransform(animate);
  }

  private applyTransform(animate = false): void {
    const vp = this.viewport;
    if (animate && !prefersReducedMotion()) {
      vp.classList.add("is-animating");
      if (this.animTimer !== null) window.clearTimeout(this.animTimer);
      this.animTimer = window.setTimeout(() => {
        vp.classList.remove("is-animating");
        this.animTimer = null;
      }, 260);
    }
    vp.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.k})`;
  }

  private zoomAt(clientX: number, clientY: number, factor: number, animate = false): void {
    const rect = this.svg.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const nextK = clamp(this.k * factor, MIN_K, MAX_K);
    const ratio = nextK / this.k;
    this.tx = px - (px - this.tx) * ratio;
    this.ty = py - (py - this.ty) * ratio;
    this.k = nextK;
    this.applyTransform(animate);
  }

  private zoomByCenter(factor: number): void {
    const rect = this.svg.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor, true);
  }

  private stopAnimation(): void {
    this.viewport.classList.remove("is-animating");
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.stopAnimation();
    const dy = clamp(e.deltaY, -120, 120);
    this.zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.002));
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    this.stopAnimation();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.downPos = { x: e.clientX, y: e.clientY };
      this.downTarget = e.target instanceof Element ? e.target : null;
      this.moved = false;
      this.attachDocListeners();
    } else {
      this.moved = true;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const cur: Point = { x: e.clientX, y: e.clientY };

    if (this.pointers.size === 1) {
      if (
        !this.moved &&
        Math.hypot(cur.x - this.downPos.x, cur.y - this.downPos.y) > DRAG_THRESHOLD
      ) {
        this.moved = true;
      }
      if (this.moved) {
        this.tx += cur.x - prev.x;
        this.ty += cur.y - prev.y;
        this.applyTransform();
      }
      this.pointers.set(e.pointerId, cur);
      return;
    }

    const before = this.metrics();
    this.pointers.set(e.pointerId, cur);
    const after = this.metrics();
    if (before && after && before.dist > 0) {
      this.tx += after.cx - before.cx;
      this.ty += after.cy - before.cy;
      this.zoomAt(after.cx, after.cy, after.dist / before.dist);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      this.detachDocListeners();
      const target = this.downTarget;
      this.downTarget = null;
      if (!this.moved && e.type === "pointerup") this.handleTap(target);
    }
  };

  private metrics(): { cx: number; cy: number; dist: number } | null {
    const pts = [...this.pointers.values()];
    const a = pts[0];
    const b = pts[1];
    if (!a || !b) return null;
    return {
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  private attachDocListeners(): void {
    if (this.listening) return;
    this.listening = true;
    this.doc.addEventListener("pointermove", this.onPointerMove);
    this.doc.addEventListener("pointerup", this.onPointerUp);
    this.doc.addEventListener("pointercancel", this.onPointerUp);
  }

  private detachDocListeners(): void {
    if (!this.listening) return;
    this.listening = false;
    this.doc.removeEventListener("pointermove", this.onPointerMove);
    this.doc.removeEventListener("pointerup", this.onPointerUp);
    this.doc.removeEventListener("pointercancel", this.onPointerUp);
  }

  private handleTap(target: Element | null): void {
    if (!target) return;

    const toggle = target.closest("[data-toggle]");
    if (toggle) {
      const p = toggle.getAttribute("data-toggle");
      if (p) this.toggleCollapse(p);
      return;
    }

    const nodeEl = target.closest("[data-path]");
    const path = nodeEl ? nodeEl.getAttribute("data-path") : null;
    if (!path) {
      this.select(null);
      return;
    }

    const now = Date.now();
    if (this.lastTapPath === path && now - this.lastTapAt < DOUBLE_TAP_MS) {
      this.lastTapPath = null;
      this.callbacks.onOpen(path);
      return;
    }
    this.lastTapPath = path;
    this.lastTapAt = now;
    this.select(path);
  }
}
