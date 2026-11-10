// C:\Users\user\dev\my-study-compiler\src\render\renderer.ts
import {
	AABB,
	HandleDescriptor,
	Scene,
	SceneElement,
	ScenePoint,
	SnapGuideLine,
} from "../scene/types";
import {
	ROTATE_HANDLE_OFFSET_PX,
	aabbIntersects,
	getElementAABB,
	getElementFrameBox,
	getSelectionAABB,
	getSelectionFrameElements,
	getTransformHandles,
	rotatePoint,
} from "../hit/hitTest";
import { renderSceneElement } from "./shapes";

export interface RenderFramePayload {
	scene: Scene;
	selectedIds: ReadonlySet<string>;
	editingElementId: string | null;
	marqueeBox: AABB | null;
	snapGuides: readonly SnapGuideLine[];
	bindingHighlightElement: SceneElement | null;
	eraserTrail: readonly ScenePoint[];
	/** Пока элемент создаётся (рисование штриха, протяжка фигуры), рамка и ручки выделения скрыты. */
	isDrawing: boolean;
}

/**
 * Высокопроизводительный рендерер бесконечного холста на HTML5 Canvas 2D:
 * - учитывает `devicePixelRatio` окна (включая popout-окна на мониторах с разным DPI);
 * - объединяет перерисовки через `requestAnimationFrame`;
 * - отсекает элементы за пределами видимой области камеры (viewport culling);
 * - кэширует `HTMLImageElement` для мгновенной отрисовки без мерцания.
 */
export class SceneCanvasRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private resolveImageUrl: (el: SceneElement, scene: Scene) => string;

	private imageCache = new Map<string, HTMLImageElement>();
	private rafId: number | null = null;
	private lastPayload: RenderFramePayload | null = null;
	private viewportWidth = 1;
	private viewportHeight = 1;
	private dpr = 1;

	constructor(
		canvas: HTMLCanvasElement,
		resolveImageUrl: (el: SceneElement, scene: Scene) => string,
		onAsyncImageLoad: () => void
	) {
		this.canvas = canvas;
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("Не удалось инициализировать 2D-контекст холста");
		}
		this.ctx = context;
		this.resolveImageUrl = (el, scene) => {
			const url = resolveImageUrl(el, scene);
			if (url && !this.imageCache.has(url)) {
				const img = new this.win.Image();
				img.onload = () => onAsyncImageLoad();
				img.onerror = () => onAsyncImageLoad();
				img.src = url;
				this.imageCache.set(url, img);
			}
			return url;
		};
	}

	private get win(): Window & typeof globalThis {
		const win = this.canvas.ownerDocument.defaultView;
		if (!win) {
			throw new Error("Не удалось определить окно холста");
		}
		return win;
	}

	public resizeCanvas(cssWidth: number, cssHeight: number): void {
		const w = Math.max(1, Math.round(cssWidth));
		const h = Math.max(1, Math.round(cssHeight));
		const nextDpr = Math.max(1, this.win.devicePixelRatio || 1);

		if (
			this.viewportWidth === w &&
			this.viewportHeight === h &&
			this.dpr === nextDpr
		) {
			return;
		}

		this.viewportWidth = w;
		this.viewportHeight = h;
		this.dpr = nextDpr;

		this.canvas.width = Math.round(w * nextDpr);
		this.canvas.height = Math.round(h * nextDpr);
		this.canvas.style.width = `${w}px`;
		this.canvas.style.height = `${h}px`;

		if (this.lastPayload) {
			this.renderImmediate(this.lastPayload);
		}
	}

	public scheduleRender(payload: RenderFramePayload): void {
		if (this.lastPayload && this.lastPayload.scene !== payload.scene) {
			this.imageCache.clear();
		}
		this.lastPayload = payload;
		if (this.rafId !== null) return;
		this.rafId = this.win.requestAnimationFrame(() => {
			this.rafId = null;
			if (this.lastPayload) {
				this.renderImmediate(this.lastPayload);
			}
		});
	}

	public renderImmediate(payload: RenderFramePayload): void {
		this.lastPayload = payload;
		const { ctx, viewportWidth, viewportHeight, dpr } = this;
		const { scene, selectedIds, editingElementId, marqueeBox, snapGuides } =
			payload;
		const { scrollX, scrollY, zoom, grid, gridSize, theme } = scene.appState;
		const safeZoom = Math.max(0.1, Math.min(30, zoom));

		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// 1. Фон бесконечного холста
		ctx.fillStyle = theme === "light" ? "#f8f9fa" : "#16181d";
		ctx.fillRect(0, 0, viewportWidth, viewportHeight);

		// 2. Бесконечная сетка (точечная/клеточная с адаптивным шагом при отдалении)
		if (grid) {
			this.drawInfiniteGrid(
				ctx,
				viewportWidth,
				viewportHeight,
				scrollX,
				scrollY,
				safeZoom,
				gridSize || 20,
				theme
			);
		}

		// 3. Переход в мировые координаты сцены: screenX = (worldX + scrollX) * zoom
		ctx.save();
		ctx.scale(safeZoom, safeZoom);
		ctx.translate(scrollX, scrollY);

		const viewAABB: AABB = {
			minX: -scrollX - 80 / safeZoom,
			minY: -scrollY - 80 / safeZoom,
			maxX: -scrollX + viewportWidth / safeZoom + 80 / safeZoom,
			maxY: -scrollY + viewportHeight / safeZoom + 80 / safeZoom,
			width: viewportWidth / safeZoom,
			height: viewportHeight / safeZoom,
			cx: -scrollX + viewportWidth / (2 * safeZoom),
			cy: -scrollY + viewportHeight / (2 * safeZoom),
		};

		const byId = new Map<string, SceneElement>();
		for (const el of scene.elements) {
			if (!el.isDeleted) byId.set(el.id, el);
		}

		// 4. Отрисовка только видимых в камере элементов
		for (const el of scene.elements) {
			if (el.isDeleted || el.containerId) continue;
			const elBox = getElementAABB(el);
			if (!aabbIntersects(viewAABB, elBox)) continue;

			const boundText = el.boundTextId ? byId.get(el.boundTextId) ?? null : null;
			const isEditing =
				editingElementId === el.id ||
				(boundText !== null && editingElementId === boundText.id);

			renderSceneElement(ctx, el, {
				getImage: (imgEl) => {
					const url = this.resolveImageUrl(imgEl, scene);
					return url ? this.imageCache.get(url) ?? null : null;
				},
				boundTextElement: boundText,
				isEditingText: isEditing,
				theme,
			});
		}

		// 5. Подсветка целевой фигуры при привязке стрелки (binding)
		if (payload.bindingHighlightElement) {
			const target = payload.bindingHighlightElement;
			ctx.save();
			ctx.strokeStyle = "#4aab80";
			ctx.lineWidth = 3 / safeZoom;
			ctx.setLineDash([]);
			ctx.strokeRect(
				target.x - 4,
				target.y - 4,
				target.width + 8,
				target.height + 8
			);
			ctx.restore();
		}

		// 6. Направляющие привязки (snap guides)
		if (snapGuides.length > 0) {
			ctx.save();
			ctx.strokeStyle = "#e06c75";
			ctx.lineWidth = 1 / safeZoom;
			ctx.setLineDash([4 / safeZoom, 4 / safeZoom]);
			for (const g of snapGuides) {
				ctx.beginPath();
				ctx.moveTo(g.x1, g.y1);
				ctx.lineTo(g.x2, g.y2);
				ctx.stroke();
			}
			ctx.restore();
		}

		// 7. Рамка и ручки выделенных элементов (скрыты, пока элемент создаётся или правится его текст)
		const selectedElements = getSelectionFrameElements(
			scene.elements.filter((el) => !el.isDeleted && selectedIds.has(el.id))
		);
		if (
			selectedElements.length > 0 &&
			!payload.isDrawing &&
			editingElementId === null
		) {
			this.drawSelectionOverlay(ctx, selectedElements, safeZoom);
		}

		// 8. Рамка выделения курсором (marquee)
		if (marqueeBox) {
			ctx.save();
			ctx.fillStyle = "rgba(92, 141, 246, 0.14)";
			ctx.strokeStyle = "#5c8df6";
			ctx.lineWidth = 1.2 / safeZoom;
			ctx.setLineDash([]);
			ctx.fillRect(
				marqueeBox.minX,
				marqueeBox.minY,
				marqueeBox.width,
				marqueeBox.height
			);
			ctx.strokeRect(
				marqueeBox.minX,
				marqueeBox.minY,
				marqueeBox.width,
				marqueeBox.height
			);
			ctx.restore();
		}

		// 9. След ластика
		if (payload.eraserTrail.length > 1) {
			ctx.save();
			ctx.strokeStyle = "rgba(224, 108, 117, 0.65)";
			ctx.lineWidth = 8 / safeZoom;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			ctx.beginPath();
			ctx.moveTo(payload.eraserTrail[0]!.x, payload.eraserTrail[0]!.y);
			for (let i = 1; i < payload.eraserTrail.length; i++) {
				ctx.lineTo(payload.eraserTrail[i]!.x, payload.eraserTrail[i]!.y);
			}
			ctx.stroke();
			ctx.restore();
		}

		ctx.restore();
		ctx.restore();
	}

	private drawInfiniteGrid(
		ctx: CanvasRenderingContext2D,
		vpW: number,
		vpH: number,
		scrollX: number,
		scrollY: number,
		zoom: number,
		baseStep: number,
		theme: "dark" | "light"
	): void {
		let step = baseStep;
		while (step * zoom < 14) {
			step *= 2;
		}

		const offsetX = ((scrollX * zoom) % (step * zoom) + step * zoom) % (step * zoom);
		const offsetY = ((scrollY * zoom) % (step * zoom) + step * zoom) % (step * zoom);
		const scaledStep = step * zoom;

		ctx.save();
		ctx.fillStyle =
			theme === "light"
				? "rgba(0, 0, 0, 0.18)"
				: "rgba(255, 255, 255, 0.14)";

		const dotRadius = Math.max(1, Math.min(1.8, zoom * 1.1));
		for (let x = offsetX; x < vpW; x += scaledStep) {
			for (let y = offsetY; y < vpH; y += scaledStep) {
				ctx.fillRect(x - dotRadius / 2, y - dotRadius / 2, dotRadius, dotRadius);
			}
		}
		ctx.restore();
	}

	private drawSelectionOverlay(
		ctx: CanvasRenderingContext2D,
		selectedElements: readonly SceneElement[],
		zoom: number
	): void {
		ctx.save();
		const inv = 1 / zoom;
		ctx.strokeStyle = "#5c8df6";
		ctx.lineWidth = 1.5 * inv;
		ctx.setLineDash([]);

		if (selectedElements.length === 1) {
			const el = selectedElements[0]!;
			if (el.type !== "arrow" && el.type !== "line") {
				const box = getElementFrameBox(el);
				const cx = box.x + box.width / 2;
				const cy = box.y + box.height / 2;
				ctx.save();
				if (el.angle) {
					ctx.translate(cx, cy);
					ctx.rotate(el.angle);
					ctx.translate(-cx, -cy);
				}
				const pad = 4 * inv;
				ctx.strokeRect(
					box.x - pad,
					box.y - pad,
					box.width + pad * 2,
					box.height + pad * 2
				);
				if (!el.locked) {
					// Линия к ручке вращения
					ctx.beginPath();
					ctx.moveTo(cx, box.y - pad);
					ctx.lineTo(cx, box.y - ROTATE_HANDLE_OFFSET_PX * inv);
					ctx.stroke();
				}
				ctx.restore();
			}
		} else {
			// Пунктирные рамки вокруг каждого элемента и общая рамка вокруг всей выборки
			for (const el of selectedElements) {
				const b = getElementAABB(el);
				ctx.save();
				ctx.setLineDash([4 * inv, 3 * inv]);
				ctx.strokeRect(b.minX, b.minY, b.width, b.height);
				ctx.restore();
			}
			const groupBox = getSelectionAABB(selectedElements);
			if (groupBox) {
				const pad = 6 * inv;
				ctx.strokeRect(
					groupBox.minX - pad,
					groupBox.minY - pad,
					groupBox.width + pad * 2,
					groupBox.height + pad * 2
				);
			}
		}

		// Отрисовка ручек трансформации / контрольных точек
		const handles: HandleDescriptor[] = getTransformHandles(
			selectedElements,
			zoom
		);
		const size = 8 * inv;

		for (const h of handles) {
			ctx.save();
			ctx.fillStyle = h.kind === "midpoint" ? "rgba(92, 141, 246, 0.45)" : "#ffffff";
			ctx.strokeStyle = "#5c8df6";
			ctx.lineWidth = 1.6 * inv;

			if (h.kind === "rotate" || h.kind === "point" || h.kind === "midpoint") {
				const r = h.kind === "midpoint" ? 4.2 * inv : 5.2 * inv;
				ctx.beginPath();
				ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
				ctx.fill();
				ctx.stroke();
			} else {
				ctx.fillRect(h.x - size / 2, h.y - size / 2, size, size);
				ctx.strokeRect(h.x - size / 2, h.y - size / 2, size, size);
			}
			ctx.restore();
		}

		ctx.restore();
	}

	public destroy(): void {
		if (this.rafId !== null) {
			this.win.cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		this.imageCache.clear();
		this.lastPayload = null;
	}
}