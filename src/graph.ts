// C:\Users\user\dev\my-study-compiler\src\graph.ts
import { setIcon } from "obsidian";
import type { CameraState, DeadlineTone, Point, StudyNoteItem } from "./types";
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
const MIN_NODE_W = 148;
const MAX_NODE_W = 268;
const MIN_NODE_H = 36;
const PAD_X = 16;
const PAD_Y = 10;
const LINE_H = 16;
const GAP_X = 72;
const GAP_Y = 18;
const MIN_K = 0.1;
const MAX_K = 2.5;
const DOUBLE_TAP_MS = 320;
const DRAG_THRESHOLD = 4;

export interface GraphCallbacks {
	onOpen: (path: string, newTab?: boolean) => void;
	onFocus: (path: string) => void;
	onOpenSchema: (path: string) => void;
	onHover?: (event: MouseEvent, targetEl: Element, path: string) => void;
	getSavedPositions: (graphKey: string) => Record<string, Point>;
	onSaveNodePosition: (graphKey: string, nodePath: string, pos: Point) => void;
	onResetNodePositions: (graphKey: string) => void;
	onCameraChange?: (cam: CameraState) => void;
}

interface LayoutNode {
	item: StudyNoteItem;
	depth: number;
	x: number;
	y: number;
	w: number;
	h: number;
	lines: string[];
	children: LayoutNode[];
	hiddenCount: number;
	hasKids: boolean;
}

interface EdgeRef {
	from: string;
	to: string;
	isExtra: boolean;
	el: SVGPathElement;
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

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureContext(doc: Document): CanvasRenderingContext2D | null {
	if (measureCtx) return measureCtx;
	const canvas = doc.createElement("canvas");
	measureCtx = canvas.getContext("2d");
	return measureCtx;
}

function measureTextWidthPx(doc: Document, text: string, isRoot: boolean): number {
	const ctx = getMeasureContext(doc);
	if (ctx) {
		ctx.font = `${isRoot ? 600 : 500} 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif`;
		return ctx.measureText(text).width;
	}
	return text.length * 7.2;
}

function wrapAndMeasureLabel(
	doc: Document,
	fullLabel: string,
	isRoot: boolean,
	hasIndicatorDots: boolean
): { lines: string[]; w: number; h: number } {
	const rightExtra = hasIndicatorDots ? 10 : 0;
	const maxTextW = MAX_NODE_W - PAD_X * 2 - rightExtra;
	const rawWords = fullLabel.trim().split(/\s+/).filter(Boolean);

	const chunks: string[] = [];
	for (const word of rawWords) {
		if (measureTextWidthPx(doc, word, isRoot) <= maxTextW) {
			chunks.push(word);
			continue;
		}
		let part = "";
		for (const ch of Array.from(word)) {
			const candidate = part + ch;
			if (part.length > 0 && measureTextWidthPx(doc, candidate, isRoot) > maxTextW) {
				chunks.push(part);
				part = ch;
			} else {
				part = candidate;
			}
		}
		if (part.length > 0) {
			chunks.push(part);
		}
	}

	const lines: string[] = [];
	let curLine = "";
	for (const token of chunks) {
		if (!curLine) {
			curLine = token;
			continue;
		}
		const candidate = `${curLine} ${token}`;
		if (measureTextWidthPx(doc, candidate, isRoot) <= maxTextW) {
			curLine = candidate;
		} else {
			lines.push(curLine);
			curLine = token;
		}
	}
	if (curLine) {
		lines.push(curLine);
	}
	if (lines.length === 0) {
		lines.push(fullLabel || "—");
	}

	let maxLineW = 0;
	for (const line of lines) {
		maxLineW = Math.max(maxLineW, measureTextWidthPx(doc, line, isRoot));
	}

	const w = clamp(
		Math.ceil(maxLineW + PAD_X * 2 + rightExtra),
		MIN_NODE_W,
		MAX_NODE_W
	);
	const h = Math.max(MIN_NODE_H, lines.length * LINE_H + PAD_Y * 2);

	return { lines, w, h };
}

export class ProjectGraphView {
	private container: HTMLElement;
	private callbacks: GraphCallbacks;
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
	private directionBtn: HTMLButtonElement;
	private resetLayoutBtn: HTMLButtonElement;

	private scan: ScanResult | null = null;
	private branchRoot: StudyNoteItem | null = null;
	private fresh: Set<string> = new Set();
	private collapsed = new Set<string>();
	private selectedPath: string | null = null;
	private direction: "LR" | "TB" = "LR";

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
	private resizeObserver: ResizeObserver | null = null;
	private lastViewportW = 0;
	private lastViewportH = 0;
	private userMovedViewport = false;

	private pointers = new Map<number, Point>();
	private downPos: Point = { x: 0, y: 0 };
	private downTarget: Element | null = null;
	private moved = false;
	private dragNodePath: string | null = null;
	private dragNodeStart: Point = { x: 0, y: 0 };
	private lastTapPath: string | null = null;
	private lastTapAt = 0;
	private listeningDoc: Document | null = null;

	constructor(container: HTMLElement, callbacks: GraphCallbacks) {
		this.container = container;
		this.callbacks = callbacks;
		container.empty();

		const d = this.doc;
		this.svg = svgEl(d, "svg", "my-sc-graph-svg");
		this.viewport = svgEl(d, "g", "my-sc-graph-viewport");
		this.edgesLayer = svgEl(d, "g", "my-sc-graph-edges");
		this.nodesLayer = svgEl(d, "g", "my-sc-graph-nodes");
		this.viewport.appendChild(this.edgesLayer);
		this.viewport.appendChild(this.nodesLayer);
		this.svg.appendChild(this.viewport);
		container.appendChild(this.svg);

		const controls = container.createDiv("my-sc-graph-controls");
		const addCtrl = (
			icon: string,
			title: string,
			fn: () => void
		): HTMLButtonElement => {
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
		addCtrl("maximize", "Показать всё", () => {
			this.userMovedViewport = false;
			this.fit(true);
		});
this.toggleAllBtn = addCtrl("chevrons-down-up", "Свернуть ветки", () => {
			if (this.collapsed.size > 0) this.collapsed.clear();
			else this.collapseDeep();
			this.rebuild();
			this.userMovedViewport = false;
			this.fit(true);
		});

		this.directionBtn = addCtrl(
			"arrow-down-right",
			"Ориентация графа: слева направо / сверху вниз",
			() => {
				this.direction = this.direction === "LR" ? "TB" : "LR";
				this.syncDirectionBtn();
				this.rebuild();
				this.userMovedViewport = false;
				this.fit(true);
			}
		);
		this.syncDirectionBtn();

		this.resetLayoutBtn = controls.createEl("button", {
			cls: "my-sc-graph-ctrl my-sc-graph-ctrl-reset",
			attr: {
				type: "button",
				title: "Сбросить расположение",
				"aria-label": "Сбросить расположение",
			},
		});
		const resetIconSpan = this.resetLayoutBtn.createSpan("my-sc-graph-ctrl-icon");
		setIcon(resetIconSpan, "rotate-ccw");
		this.resetLayoutBtn.createSpan({
			cls: "my-sc-graph-ctrl-label",
			text: "Упорядочить",
		});
		this.resetLayoutBtn.onclick = () => {
			if (!this.branchRoot) return;
			this.callbacks.onResetNodePositions(this.branchRoot.path);
			this.userMovedViewport = false;
			this.rebuild();
			this.fit(true);
		};

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
		openBtn.onclick = (e: MouseEvent) => {
			if (this.selectedPath) {
				this.callbacks.onOpen(this.selectedPath, e.ctrlKey || e.metaKey);
			}
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
			attr: {
				type: "button",
				title: "Снять выделение",
				"aria-label": "Снять выделение",
			},
		});
		setIcon(clearBtn, "x");
		clearBtn.onclick = () => this.select(null);

		const footer = container.createDiv("my-sc-graph-footer");
		this.statEl = footer.createSpan("my-sc-graph-stat");

		this.svg.addEventListener("pointerdown", this.onPointerDown);
		container.addEventListener("wheel", this.onWheel, { passive: false });

		if (typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => {
				this.notifyResize();
			});
			this.resizeObserver.observe(this.container);
		}
	}

	private get doc(): Document {
		return this.container.doc ?? this.container.ownerDocument ?? activeDocument ?? document;
	}

	private get win(): Window {
		return this.container.win ?? this.doc.defaultView ?? activeWindow ?? window;
	}

	public getCameraState(): CameraState {
		return {
			scale: this.k,
			panX: this.tx,
			panY: this.ty,
		};
	}

	public notifyResize(): void {
		const w = Math.round(this.container.clientWidth);
		const h = Math.round(this.container.clientHeight);
		if (w <= 0 || h <= 0) return;
		const sizeChanged =
			Math.abs(w - this.lastViewportW) > 2 || Math.abs(h - this.lastViewportH) > 2;
		if (!sizeChanged && !this.pendingFit) return;
		const wasZero = this.lastViewportW === 0 || this.lastViewportH === 0;
		this.lastViewportW = w;
		this.lastViewportH = h;
		if (this.pendingFit || wasZero || !this.userMovedViewport) {
			this.pendingFit = false;
			this.fit(false);
		}
	}

	update(
		scan: ScanResult,
		branchRoot: StudyNoteItem,
		resetView: boolean,
		fresh: ReadonlySet<string>,
		initialCamera?: CameraState | null
	): void {
		this.scan = scan;
		this.branchRoot = branchRoot;
		this.fresh = new Set(fresh);
		if (resetView) {
			this.collapsed.clear();
			this.selectedPath = null;
			if (initialCamera) {
				this.k = clamp(initialCamera.scale, MIN_K, MAX_K);
				this.tx = initialCamera.panX;
				this.ty = initialCamera.panY;
				this.userMovedViewport = true;
				this.pendingFit = false;
			} else {
				this.userMovedViewport = false;
				this.pendingFit = true;
			}
		}
		this.rebuild();
		if (initialCamera && resetView) {
			this.applyTransform(false);
		} else if (this.pendingFit) {
			this.win.requestAnimationFrame(() => this.tryFit());
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
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.animTimer !== null) {
			this.win.clearTimeout(this.animTimer);
			this.animTimer = null;
		}
		this.svg.removeEventListener("pointerdown", this.onPointerDown);
		this.container.removeEventListener("wheel", this.onWheel);
		this.container.empty();
	}

private shiftSubtreeY(node: LayoutNode, dy: number): void {
		if (Math.abs(dy) < 0.01) return;
		node.y += dy;
		for (const c of node.children) {
			this.shiftSubtreeY(c, dy);
		}
	}

	private shiftSubtreeX(node: LayoutNode, dx: number): void {
		if (Math.abs(dx) < 0.01) return;
		node.x += dx;
		for (const c of node.children) {
			this.shiftSubtreeX(c, dx);
		}
	}

	private recomputeBounds(): void {
		if (this.placed.length === 0) {
			this.bounds = { minX: 0, minY: 0, w: 1, h: 1 };
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of this.placed) {
			minX = Math.min(minX, n.x);
			minY = Math.min(minY, n.y);
			maxX = Math.max(maxX, n.x + n.w + 24);
			maxY = Math.max(maxY, n.y + n.h);
		}
		this.bounds = {
			minX,
			minY,
			w: Math.max(1, maxX - minX),
			h: Math.max(1, maxY - minY),
		};
	}

private computeEdgePathD(a: LayoutNode, b: LayoutNode): string {
		if (this.direction === "TB") {
			const x1 = a.x + a.w / 2;
			const y1 = a.y + a.h;
			const x2 = b.x + b.w / 2;
			const y2 = b.y;
			const dy = Math.max(32, Math.abs(y2 - y1) * 0.45);
			return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
		}
		const x1 = a.x + a.w;
		const y1 = a.y + a.h / 2;
		const x2 = b.x;
		const y2 = b.y + b.h / 2;
		const dx = Math.max(36, Math.abs(x2 - x1) * 0.45);
		return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
	}

	private updateEdgesForNode(nodePath: string): void {
		for (const e of this.edgeRefs) {
			if (e.from !== nodePath && e.to !== nodePath) continue;
			const a = this.nodeByPath.get(e.from);
			const b = this.nodeByPath.get(e.to);
			if (!a || !b) continue;
			e.el.setAttribute("d", this.computeEdgePathD(a, b));
		}
	}

	private rebuild(): void {
		const scan = this.scan;
		const root = this.branchRoot;
		if (!scan || !root) return;

		const d = this.doc;
		const visited = new Set<string>([root.path]);
		const extra: Array<[string, string]> = [];
		const maxWidthByDepth = new Map<number, number>();

		const make = (item: StudyNoteItem, depth: number): LayoutNode => {
			const kidPaths = scan.childrenOf.get(item.path) ?? [];
			const meta = getWorkMeta(item.noteType, item.icon);
			const tone: DeadlineTone = getDeadlineTone(item);
			const hasMediaOrSchema =
				item.mediaItems.length > 0 || item.annotationCount > 0;
			const hasDots =
				hasMediaOrSchema || tone === "overdue" || tone === "soon";
			const { lines, w, h } = wrapAndMeasureLabel(
				d,
				`${meta.icon} ${item.name}`,
				depth === 0,
				hasDots
			);

			const prevMaxW = maxWidthByDepth.get(depth) ?? 0;
			if (w > prevMaxW) maxWidthByDepth.set(depth, w);

			const node: LayoutNode = {
				item,
				depth,
				x: 0,
				y: 0,
				w,
				h,
				lines,
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

		if (this.direction === "TB") {
			const rowY = new Map<number, number>();
			let runningY = 0;
			const maxDepth = Math.max(0, ...Array.from(maxWidthByDepth.keys()));
			for (let dep = 0; dep <= maxDepth; dep++) {
				rowY.set(dep, runningY);
				runningY += MIN_NODE_H + GAP_X;
			}

			let leafCursorX = 0;
			const nextMinXByDepth = new Map<number, number>();
			const placeTB = (n: LayoutNode) => {
				n.y = rowY.get(n.depth) ?? n.depth * (MIN_NODE_H + GAP_X);
				const minForDepth = nextMinXByDepth.get(n.depth) ?? 0;

				if (n.children.length === 0) {
					n.x = Math.max(leafCursorX, minForDepth);
					leafCursorX = n.x + n.w + GAP_Y;
					nextMinXByDepth.set(n.depth, n.x + n.w + GAP_Y);
					return;
				}

				for (const c of n.children) placeTB(c);
				const first = n.children[0];
				const last = n.children[n.children.length - 1];
				const firstCenter = first ? first.x + first.w / 2 : 0;
				const lastCenter = last ? last.x + last.w / 2 : 0;
				let desiredX = Math.round((firstCenter + lastCenter) / 2 - n.w / 2);

				if (desiredX < minForDepth) {
					const delta = minForDepth - desiredX;
					desiredX = minForDepth;
					for (const c of n.children) {
						this.shiftSubtreeX(c, delta);
					}
					leafCursorX = Math.max(leafCursorX + delta, desiredX + n.w + GAP_Y);
				}

				n.x = desiredX;
				leafCursorX = Math.max(leafCursorX, n.x + n.w + GAP_Y);
				nextMinXByDepth.set(n.depth, n.x + n.w + GAP_Y);
			};
			placeTB(tree);
		} else {
			const colX = new Map<number, number>();
			let runningX = 0;
			const maxDepth = Math.max(0, ...Array.from(maxWidthByDepth.keys()));
			for (let dep = 0; dep <= maxDepth; dep++) {
				colX.set(dep, runningX);
				const colW = maxWidthByDepth.get(dep) ?? MIN_NODE_W;
				runningX += colW + GAP_X;
			}

			let leafCursorY = 0;
			const nextMinYByDepth = new Map<number, number>();

			const placeLR = (n: LayoutNode) => {
				n.x = colX.get(n.depth) ?? n.depth * (MIN_NODE_W + GAP_X);
				const minForDepth = nextMinYByDepth.get(n.depth) ?? 0;

				if (n.children.length === 0) {
					n.y = Math.max(leafCursorY, minForDepth);
					leafCursorY = n.y + n.h + GAP_Y;
					nextMinYByDepth.set(n.depth, n.y + n.h + GAP_Y);
					return;
				}

				for (const c of n.children) placeLR(c);
				const first = n.children[0];
				const last = n.children[n.children.length - 1];
				const firstCenter = first ? first.y + first.h / 2 : 0;
				const lastCenter = last ? last.y + last.h / 2 : 0;
				let desiredY = Math.round((firstCenter + lastCenter) / 2 - n.h / 2);

				if (desiredY < minForDepth) {
					const delta = minForDepth - desiredY;
					desiredY = minForDepth;
					for (const c of n.children) {
						this.shiftSubtreeY(c, delta);
					}
					leafCursorY = Math.max(leafCursorY + delta, desiredY + n.h + GAP_Y);
				}

				n.y = desiredY;
				leafCursorY = Math.max(leafCursorY, n.y + n.h + GAP_Y);
				nextMinYByDepth.set(n.depth, n.y + n.h + GAP_Y);
			};
			placeLR(tree);
		}

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

		const savedMap = this.callbacks.getSavedPositions(root.path);
		for (const n of this.placed) {
			const saved = savedMap[n.item.path];
			if (
				saved &&
				typeof saved.x === "number" &&
				Number.isFinite(saved.x) &&
				typeof saved.y === "number" &&
				Number.isFinite(saved.y)
			) {
				n.x = saved.x;
				n.y = saved.y;
			}
		}

		this.recomputeBounds();
		this.renderLayers(extra);

		if (this.selectedPath && !this.nodeByPath.has(this.selectedPath)) {
			this.selectedPath = null;
		}
		this.applySelection();
		this.updateInfo();
		this.syncToggleAll();
		this.syncResetLayoutBtn();

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
		setIcon(
			this.toggleAllBtn,
			anyCollapsed ? "chevrons-up-down" : "chevrons-down-up"
		);
		this.toggleAllBtn.setAttribute("title", title);
		this.toggleAllBtn.setAttribute("aria-label", title);
	}

	private syncDirectionBtn(): void {
		if (!this.directionBtn) return;
		this.directionBtn.empty();
		const isTB = this.direction === "TB";
		setIcon(this.directionBtn, isTB ? "arrow-down" : "arrow-right");
		const title = isTB
			? "Ориентация: сверху вниз (нажми для слева направо)"
			: "Ориентация: слева направо (нажми для сверху вниз)";
		this.directionBtn.setAttribute("title", title);
		this.directionBtn.setAttribute("aria-label", title);
	}

	private syncResetLayoutBtn(): void {
		if (!this.branchRoot) return;
		const saved = this.callbacks.getSavedPositions(this.branchRoot.path);
		const hasCustom = Object.keys(saved).length > 0;
		this.resetLayoutBtn.toggleClass("has-custom-positions", hasCustom);
	}

	private renderLayers(extra: Array<[string, string]>): void {
		this.edgesLayer.replaceChildren();
		this.nodesLayer.replaceChildren();
		this.nodeEls.clear();
		this.edgeRefs = [];

		const d = this.doc;

		const addEdge = (fromPath: string, toPath: string, isExtra: boolean) => {
			const a = this.nodeByPath.get(fromPath);
			const b = this.nodeByPath.get(toPath);
			if (!a || !b) return;
			const path = svgEl(
				d,
				"path",
				"my-sc-gedge" + (isExtra ? " is-extra" : "")
			);
			path.setAttribute("d", this.computeEdgePathD(a, b));
			this.edgesLayer.appendChild(path);
			this.edgeRefs.push({ from: fromPath, to: toPath, isExtra, el: path });
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

			const g = svgEl(d, "g", cls);
			g.setAttribute("transform", `translate(${n.x} ${n.y})`);
			g.setAttribute("data-path", item.path);
			g.style.setProperty("--node-color", meta.color);

			const title = d.createElementNS(SVG_NS, "title");
			title.textContent =
				`${item.name} · ${item.noteType || "без типа"}` +
				(item.deadline ? ` · ${formatDeadlineBadge(item)}` : "") +
				(hasMediaOrSchema
					? ` · Иллюстраций: ${item.mediaItems.length}, аннотаций: ${item.annotationCount}`
					: "");
			g.appendChild(title);

			const body = svgEl(d, "rect", "my-sc-gnode-body");
			body.setAttribute("width", String(n.w));
			body.setAttribute("height", String(n.h));
			body.setAttribute("rx", "8");
			g.appendChild(body);

			const stripe = svgEl(d, "rect", "my-sc-gnode-stripe");
			stripe.setAttribute("width", "4");
			stripe.setAttribute("height", String(n.h));
			stripe.setAttribute("rx", "2");
			g.appendChild(stripe);

			const text = svgEl(d, "text", "my-sc-gnode-label");
			const textCenterX = Math.round(n.w / 2);
			const blockH = n.lines.length * LINE_H;
			const firstLineY = (n.h - blockH) / 2 + LINE_H / 2;
			text.setAttribute("text-anchor", "middle");

			n.lines.forEach((lineStr, idx) => {
				const tspan = svgEl(d, "tspan");
				tspan.setAttribute("x", String(textCenterX));
				tspan.setAttribute(
					"y",
					String(Math.round((firstLineY + idx * LINE_H) * 10) / 10)
				);
				tspan.setAttribute("dominant-baseline", "central");
				tspan.textContent = lineStr;
				text.appendChild(tspan);
			});
			g.appendChild(text);

			if (hasMediaOrSchema) {
				const schemaDot = svgEl(d, "circle", "my-sc-gnode-schema-dot");
				schemaDot.setAttribute("cx", String(n.w - 10));
				schemaDot.setAttribute("cy", String(n.h - 9));
				schemaDot.setAttribute("r", "3.5");
				g.appendChild(schemaDot);
			}

			if (tone === "overdue" || tone === "soon") {
				const dot = svgEl(d, "circle", "my-sc-gnode-dot");
				dot.setAttribute("cx", String(n.w - 10));
				dot.setAttribute("cy", "9");
				dot.setAttribute("r", "3.5");
				g.appendChild(dot);
			}

			if (n.hasKids) {
				const isCollapsed = this.collapsed.has(item.path);
				const label = isCollapsed ? `+${n.hiddenCount}` : "−";
				const pillW = isCollapsed ? 14 + label.length * 6 : 20;
				const tg = svgEl(
					d,
					"g",
					"my-sc-gtoggle" + (isCollapsed ? " is-collapsed" : "")
				);
				tg.setAttribute("data-toggle", item.path);
				const pill = svgEl(d, "rect", "my-sc-gtoggle-pill");
				pill.setAttribute("x", String(n.w - pillW / 2));
				pill.setAttribute("y", String(n.h / 2 - 9));
				pill.setAttribute("width", String(pillW));
				pill.setAttribute("height", "18");
				pill.setAttribute("rx", "9");
				const t = svgEl(d, "text", "my-sc-gtoggle-label");
				t.setAttribute("x", String(n.w));
				t.setAttribute("y", String(n.h / 2));
				t.setAttribute("text-anchor", "middle");
				t.setAttribute("dominant-baseline", "central");
				t.textContent = label;
				tg.appendChild(pill);
				tg.appendChild(t);
				g.appendChild(tg);
			}

g.addEventListener("mouseenter", (evt: MouseEvent) => {
				this.callbacks.onHover?.(evt, g, item.path);
			});

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
		const node = this.selectedPath
			? this.nodeByPath.get(this.selectedPath)
			: undefined;
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
		this.lastViewportW = w;
		this.lastViewportH = h;
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
			if (this.animTimer !== null) this.win.clearTimeout(this.animTimer);
			this.animTimer = this.win.setTimeout(() => {
				vp.classList.remove("is-animating");
				this.animTimer = null;
			}, 260);
		}
		vp.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.k})`;
		this.callbacks.onCameraChange?.(this.getCameraState());
	}

	private zoomAt(
		clientX: number,
		clientY: number,
		factor: number,
		animate = false
	): void {
		const rect = this.svg.getBoundingClientRect();
		const px = clientX - rect.left;
		const py = clientY - rect.top;
		const nextK = clamp(this.k * factor, MIN_K, MAX_K);
		const ratio = nextK / this.k;
		this.tx = px - (px - this.tx) * ratio;
		this.ty = py - (py - this.ty) * ratio;
		this.k = nextK;
		this.userMovedViewport = true;
		this.applyTransform(animate);
	}

	private zoomByCenter(factor: number): void {
		const rect = this.svg.getBoundingClientRect();
		this.zoomAt(
			rect.left + rect.width / 2,
			rect.top + rect.height / 2,
			factor,
			true
		);
	}

	private stopAnimation(): void {
		this.viewport.classList.remove("is-animating");
	}

	private clearDraggingState(): void {
		if (this.dragNodePath) {
			this.nodeEls.get(this.dragNodePath)?.classList.remove("is-dragging");
			this.dragNodePath = null;
		}
	}

	private onWheel = (e: WheelEvent): void => {
		e.preventDefault();
		this.stopAnimation();
		const dy = clamp(e.deltaY, -120, 120);
		this.zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.002));
	};

	private onPointerDown = (e: PointerEvent): void => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		e.preventDefault();
		this.stopAnimation();
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

		if (this.pointers.size === 1) {
			this.downPos = { x: e.clientX, y: e.clientY };
			const target = e.target instanceof Element ? e.target : null;
			this.downTarget = target;
			this.moved = false;
			this.dragNodePath = null;

			if (target && !target.closest("[data-toggle]")) {
				const nodeEl = target.closest("[data-path]");
				const path = nodeEl?.getAttribute("data-path") ?? null;
				const layoutNode = path ? this.nodeByPath.get(path) : undefined;
				if (path && layoutNode) {
					this.dragNodePath = path;
					this.dragNodeStart = { x: layoutNode.x, y: layoutNode.y };
				}
			}

			this.attachDocListeners();
		} else {
			if (this.dragNodePath && this.moved && this.branchRoot) {
				const n = this.nodeByPath.get(this.dragNodePath);
				if (n) {
					this.callbacks.onSaveNodePosition(
						this.branchRoot.path,
						this.dragNodePath,
						{
							x: n.x,
							y: n.y,
						}
					);
					this.syncResetLayoutBtn();
				}
			}
			this.clearDraggingState();
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
				if (this.dragNodePath) {
					const el = this.nodeEls.get(this.dragNodePath);
					if (el) {
						el.classList.add("is-dragging");
						this.nodesLayer.appendChild(el);
					}
				}
			}

			if (this.moved) {
				if (this.dragNodePath) {
					const n = this.nodeByPath.get(this.dragNodePath);
					if (n) {
						const safeK = this.k > 0.01 ? this.k : 1;
						const dx = (cur.x - this.downPos.x) / safeK;
						const dy = (cur.y - this.downPos.y) / safeK;
						n.x = Math.round(this.dragNodeStart.x + dx);
						n.y = Math.round(this.dragNodeStart.y + dy);
						const gEl = this.nodeEls.get(this.dragNodePath);
						if (gEl) {
							gEl.setAttribute("transform", `translate(${n.x} ${n.y})`);
						}
						this.updateEdgesForNode(this.dragNodePath);
						this.recomputeBounds();
					}
				} else {
					this.tx += cur.x - prev.x;
					this.ty += cur.y - prev.y;
					this.userMovedViewport = true;
					this.applyTransform();
				}
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
			const draggedPath = this.dragNodePath;
			const wasMoved = this.moved;

			this.downTarget = null;
			this.clearDraggingState();

			if (wasMoved && draggedPath && this.branchRoot) {
				const n = this.nodeByPath.get(draggedPath);
				if (n) {
					this.callbacks.onSaveNodePosition(this.branchRoot.path, draggedPath, {
						x: n.x,
						y: n.y,
					});
					this.syncResetLayoutBtn();
				}
				return;
			}

			if (!wasMoved && e.type === "pointerup") {
				this.handleTap(target, e.ctrlKey || e.metaKey);
			}
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
		if (this.listeningDoc) return;
		const d = this.doc;
		this.listeningDoc = d;
		d.addEventListener("pointermove", this.onPointerMove);
		d.addEventListener("pointerup", this.onPointerUp);
		d.addEventListener("pointercancel", this.onPointerUp);
	}

	private detachDocListeners(): void {
		if (!this.listeningDoc) return;
		this.listeningDoc.removeEventListener("pointermove", this.onPointerMove);
		this.listeningDoc.removeEventListener("pointerup", this.onPointerUp);
		this.listeningDoc.removeEventListener("pointercancel", this.onPointerUp);
		this.listeningDoc = null;
	}

	private handleTap(target: Element | null, newTab = false): void {
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
			this.callbacks.onOpen(path, newTab);
			return;
		}
		this.lastTapPath = path;
		this.lastTapAt = now;
		this.select(path);
	}
}