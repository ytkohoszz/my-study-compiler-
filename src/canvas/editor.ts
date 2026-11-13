import { Notice, setIcon } from "obsidian";
import {
	AABB,
	CanvasToolId,
	DEFAULT_ELEMENT_STYLE,
	ElementStyleDefaults,
	HandleDescriptor,
	Scene,
	SceneElement,
	SceneFileEntry,
	ScenePoint,
	SnapGuideLine,
	cloneSceneElement,
	generateElementId,
} from "../scene/types";
import { SceneHistory } from "../scene/history";
import {
	computeSnapOffset,
	findNearestBindingTarget,
	updateBoundElements,
} from "../hit/bindings";
import {
	getElementAABB,
	getElementAtPoint,
	getSelectionAABB,
	getSelectionFrameElements,
	getTransformHandles,
	hitTestHandles,
	normalizeElementBounds,
} from "../hit/hitTest";
import { isResizeHandle, resizeBoxFromHandle } from "../hit/transform";
import {
	CanvasPoint,
	canvasPointToWorld,
	getCanvasPoint,
	getDistance,
	getMidpoint,
	isEditableTarget,
	pointerToWorld,
} from "../input/pointer";
import { CanvasCommand, getCanvasCommand, getToolForKey } from "../input/keyboard";
import {
	appendFreedrawPoint,
	createSceneElement,
	finalizeElementSize,
	getElementTypeForTool,
	updateElementFromDrag,
} from "../tools/createElement";
import { CanvasTextEditor, TextEditorCloseReason, TextEditorLayout } from "../text/editor";
import {
	TextAnchor,
	fitTextElementToContent,
	getAnchoredTextX,
	getContainerTextBox,
	getDefaultTextColor,
	getMeasureContext,
	getTextAnchor,
	getTextWrapWidth,
	measureTextBlock,
} from "../text/metrics";
import {
	TextGeometry,
	resizeTextFromHandle,
	scaleTextWithGroup,
} from "../text/resize";
import { RenderFramePayload, SceneCanvasRenderer } from "../render/renderer";
import { CameraState } from "../types";

export interface CanvasEditorCallbacks {
	onSceneChange: (scene: Scene) => void;
	onCameraChange?: (camera: CameraState) => void;
	onPickImage: (point: ScenePoint) => void;
	onPasteImage: (file: File, point: ScenePoint) => Promise<void>;
	onOpenLink: (link: string, newTab: boolean) => void;
	onExportPng?: (blob: Blob) => Promise<void>;
}
interface AsyncClipboardItemLike {
	readonly types: readonly string[];
	getType(type: string): Promise<Blob>;
}

interface AsyncClipboardLike {
	read?: () => Promise<AsyncClipboardItemLike[]>;
	readText?: () => Promise<string>;
}

interface ElectronNativeImageLike {
	isEmpty(): boolean;
	toPNG(): Uint8Array;
}

interface ElectronClipboardLike {
	readImage?: () => ElectronNativeImageLike;
	readText?: () => string;
}

type PointerInteraction =
	| {
			kind: "pan";
			pointerId: number;
			startScreen: CanvasPoint;
			lastScreen: CanvasPoint;
			startWorld: ScenePoint;
			didMove: boolean;
	  }
	| {
			kind: "create";
			pointerId: number;
			startScreen: CanvasPoint;
			startWorld: ScenePoint;
			elementId: string;
			didMove: boolean;
	  }
	| {
			kind: "move";
			pointerId: number;
			startScreen: CanvasPoint;
			startWorld: ScenePoint;
			startElements: Map<string, SceneElement>;
			movingIds: Set<string>;
			didMove: boolean;
			duplicateOnMove: boolean;
			started: boolean;
	  }
	| {
			kind: "resize";
			pointerId: number;
			startScreen: CanvasPoint;
			startWorld: ScenePoint;
			startElements: Map<string, SceneElement>;
			startBounds: AABB;
			handle: HandleDescriptor;
	  }
	| {
			kind: "rotate";
			pointerId: number;
			startScreen: CanvasPoint;
			startWorld: ScenePoint;
			startElements: Map<string, SceneElement>;
			center: ScenePoint;
			startAngle: number;
	  }
	| {
			kind: "point";
			pointerId: number;
			startScreen: CanvasPoint;
			startWorld: ScenePoint;
			elementId: string;
			pointIndex: number;
	  }
	| {
			kind: "marquee";
			pointerId: number;
			startScreen: CanvasPoint;
			startWorld: ScenePoint;
			currentWorld: ScenePoint;
			selectionBefore: Set<string>;
			additive: boolean;
	  }
	| {
			kind: "erase";
			pointerId: number;
			startScreen: CanvasPoint;
			startWorld: ScenePoint;
			didErase: boolean;
	  };

interface TextEditSession {
	elementId: string;
	isNew: boolean;
	anchor: TextAnchor;
}

interface MenuAction {
	title: string;
	icon?: string;
	onClick: () => void;
}

interface SegmentedOption<T> {
	value: T;
	title: string;
	label?: string;
	obsidianIcon?: string;
	renderSvg?: (svg: SVGSVGElement, doc: Document) => void;
}

const SCENE_CLIPBOARD_PREFIX = "MY_STUDY_COMPILER_SCENE:";
const SVG_NS = "http://www.w3.org/2000/svg";

const STROKE_PALETTE: ReadonlyArray<{ color: string; title: string }> = [
	{ color: "#ffffff", title: "Белый" },
	{ color: "#cbd5e1", title: "Светло-серый" },
	{ color: "#868e96", title: "Серый" },
	{ color: "#1e1e1e", title: "Чёрный" },
	{ color: "#e5a158", title: "Янтарный" },
	{ color: "#e06c75", title: "Красный" },
	{ color: "#4aab80", title: "Зелёный" },
	{ color: "#599ed6", title: "Синий" },
	{ color: "#4fb3d9", title: "Голубой" },
	{ color: "#9c83e8", title: "Фиолетовый" },
	{ color: "#d882b6", title: "Розовый" },
	{ color: "#d4c05a", title: "Жёлтый" },
];

const BACKGROUND_PALETTE: ReadonlyArray<{ color: string; preview: string; title: string }> = [
	{ color: "transparent", preview: "transparent", title: "Прозрачный" },
	{ color: "rgba(229, 161, 88, 0.18)", preview: "#e5a158", title: "Янтарный" },
	{ color: "rgba(224, 108, 117, 0.18)", preview: "#e06c75", title: "Красный" },
	{ color: "rgba(74, 171, 128, 0.18)", preview: "#4aab80", title: "Зелёный" },
	{ color: "rgba(89, 158, 214, 0.18)", preview: "#599ed6", title: "Синий" },
	{ color: "rgba(79, 179, 217, 0.18)", preview: "#4fb3d9", title: "Голубой" },
	{ color: "rgba(156, 131, 232, 0.18)", preview: "#9c83e8", title: "Фиолетовый" },
	{ color: "rgba(216, 130, 182, 0.18)", preview: "#d882b6", title: "Розовый" },
	{ color: "rgba(212, 192, 90, 0.18)", preview: "#d4c05a", title: "Жёлтый" },
	{ color: "rgba(255, 255, 255, 0.10)", preview: "#cbd5e1", title: "Светлый" },
	{ color: "rgba(30, 34, 42, 0.72)", preview: "#2d3340", title: "Тёмный" },
];

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function cloneElementMap(
	elements: readonly SceneElement[],
	ids: ReadonlySet<string>
): Map<string, SceneElement> {
	const result = new Map<string, SceneElement>();
	for (const element of elements) {
		if (!element.isDeleted && ids.has(element.id)) {
			result.set(element.id, cloneSceneElement(element));
		}
	}
	return result;
}

function getMaxZIndex(elements: readonly SceneElement[]): number {
	return elements.reduce(
		(max, element) => (element.isDeleted ? max : Math.max(max, element.zIndex)),
		-1
	);
}

function getTextValue(element: SceneElement): string {
	return typeof element.text === "string" ? element.text : "";
}

function isTextContainer(element: SceneElement): boolean {
	return (
		element.type === "rectangle" ||
		element.type === "diamond" ||
		element.type === "ellipse"
	);
}

function getTextOffsetY(
	align: SceneElement["verticalAlign"],
	boxHeight: number,
	textHeight: number
): number {
	if (align === "bottom") return boxHeight - textHeight;
	if (align === "middle") return (boxHeight - textHeight) / 2;
	return 0;
}

function normalizeColorToHex(color: string): string {
	const trimmed = color.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
	if (/^#[0-9a-f]{3}$/.test(trimmed)) {
		return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
	}
	const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
	if (rgbMatch) {
		const r = clamp(Number(rgbMatch[1]), 0, 255).toString(16).padStart(2, "0");
		const g = clamp(Number(rgbMatch[2]), 0, 255).toString(16).padStart(2, "0");
		const b = clamp(Number(rgbMatch[3]), 0, 255).toString(16).padStart(2, "0");
		return `#${r}${g}${b}`;
	}
	return "#e5a158";
}

function hexToSoftRgba(hex: string, alpha = 0.2): string {
	const clean = normalizeColorToHex(hex).slice(1);
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class CanvasSceneEditor {
	private host: HTMLElement;
	private callbacks: CanvasEditorCallbacks;
	private resolveImageUrl: (element: SceneElement, scene: Scene) => string;
	private doc: Document;
	private win: Window & typeof globalThis;

	private root!: HTMLDivElement;
	private toolbarEl!: HTMLDivElement;
	private workspaceEl!: HTMLDivElement;
	private propertiesEl!: HTMLElement;
	private canvasWrapEl!: HTMLDivElement;
	private canvasEl!: HTMLCanvasElement;
	private controlsEl!: HTMLDivElement;
	private zoomLabelEl!: HTMLButtonElement;
	private undoBtn!: HTMLButtonElement;
	private redoBtn!: HTMLButtonElement;
	private propsToggleBtn!: HTMLButtonElement;
	private menuEl!: HTMLDivElement;
	private menuPanelEl!: HTMLDivElement;
	private toolButtonById = new Map<CanvasToolId, HTMLButtonElement>();
	private menuToggleByKey = new Map<string, HTMLInputElement>();

	private scene: Scene;
	private renderer!: SceneCanvasRenderer;
	private textEditor!: CanvasTextEditor;
	private resizeObserver: ResizeObserver | null = null;
	private history = new SceneHistory();
	private selectedIds = new Set<string>();
	private activeTool: CanvasToolId = "select";
	private interaction: PointerInteraction | null = null;
	private activePointers = new Map<number, CanvasPoint>();
	private pinchState: {
		distance: number;
		zoom: number;
		anchorWorld: ScenePoint;
	} | null = null;
	private spacePressed = false;
	private destroyed = false;
	private editingElementId: string | null = null;
	private textEditSession: TextEditSession | null = null;
	private marqueeBox: AABB | null = null;
	private snapGuides: SnapGuideLine[] = [];
	private bindingHighlightElement: SceneElement | null = null;
	private eraserTrail: ScenePoint[] = [];
	private selectionBarEl!: HTMLDivElement;
	private penOnlyBtn: HTMLButtonElement | null = null;
	private penOnlyMode = false;
	private propertiesOpen = false;
	private lastPointerWorld: ScenePoint | null = null;
	private isPasting = false;
	private lastPasteAt = 0;
	private copiedStyle: ElementStyleDefaults | null = null;

	private readonly onPointerDownBound = (event: PointerEvent) =>
		this.handlePointerDown(event);
	private readonly onPointerMoveBound = (event: PointerEvent) =>
		this.handlePointerMove(event);
	private readonly onPointerUpBound = (event: PointerEvent) =>
		this.handlePointerUp(event);
	private readonly onWheelBound = (event: WheelEvent) =>
		this.handleWheel(event);
	private readonly onKeyDownBound = (event: KeyboardEvent) =>
		this.handleKeyDown(event);
	private readonly onDocKeyDownBound = (event: KeyboardEvent) =>
		this.handleDocumentKeyDown(event);
	private readonly onKeyUpBound = (event: KeyboardEvent) =>
		this.handleKeyUp(event);
	private readonly onCopyBound = (event: ClipboardEvent) =>
		this.handleCopy(event);
	private readonly onCutBound = (event: ClipboardEvent) =>
		this.handleCut(event);
	private readonly onPasteBound = (event: ClipboardEvent) =>
		this.handlePaste(event);
	private readonly onDragOverBound = (event: DragEvent) =>
		this.handleDragOver(event);
	private readonly onDropBound = (event: DragEvent) =>
		this.handleDrop(event);
	private readonly onDoubleClickBound = (event: MouseEvent) =>
		this.handleDoubleClick(event);
	private readonly onContextMenuBound = (event: MouseEvent) =>
		this.handleContextMenu(event);
	private readonly onWindowBlurBound = () => this.handleWindowBlur();

	constructor(
		host: HTMLElement,
		scene: Scene,
		callbacks: CanvasEditorCallbacks,
		resolveImageUrl: (element: SceneElement, scene: Scene) => string
	) {
		this.host = host;
		this.scene = scene;
		this.callbacks = callbacks;
		this.resolveImageUrl = resolveImageUrl;
		this.doc = host.ownerDocument;
		const win = this.doc.defaultView;
		if (!win) {
			throw new Error("Не удалось определить окно холста");
		}
		this.win = win;
		this.buildDOM();
		this.textEditor = new CanvasTextEditor(this.canvasWrapEl);
		this.renderer = new SceneCanvasRenderer(
			this.canvasEl,
			(element, currentScene) => this.resolveImageUrl(element, currentScene),
			() => this.renderFrame()
		);
		this.bindEvents();
		this.setTool(scene.appState.activeTool || "select", false);
		this.resizeCanvas();
		this.renderFrame();
	}

	public getCameraState(): CameraState {
		const zoom = this.scene.appState.zoom;
		return {
			scale: zoom,
			panX: this.scene.appState.scrollX * zoom,
			panY: this.scene.appState.scrollY * zoom,
		};
	}

	public getScene(): Scene {
		return this.scene;
	}

	public setScene(scene: Scene, camera?: CameraState | null): void {
		if (this.textEditor.isOpen()) this.textEditor.close(true);
		this.scene = scene;
		this.selectedIds.clear();
		this.history.clear();
		this.lastPointerWorld = null;
		this.activeTool = scene.appState.activeTool || "select";
		if (camera) {
			this.setCameraState(camera, false);
		}
		this.updateToolButtons();
		this.updateMenuToggles();
		this.updateHistoryButtons();
		this.updatePropertiesPanel();
		this.renderFrame();
	}

	public setCameraState(camera: CameraState, notify = true): void {
		const zoom = clamp(camera.scale, 0.1, 30);
		this.scene.appState.zoom = zoom;
		this.scene.appState.scrollX = camera.panX / zoom;
		this.scene.appState.scrollY = camera.panY / zoom;
		this.positionTextEditor();
		this.renderFrame();
		if (notify) this.notifySceneAndCameraChanged();
	}

	public notifyResize(): void {
		this.resizeCanvas();
	}

	public fitToContent(): void {
		this.fitToAll();
	}

	public addImage(
		fileEntry: SceneFileEntry,
		width: number,
		height: number,
		point: ScenePoint
	): void {
		this.scene.files[fileEntry.id] = { ...fileEntry };
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const safeWidth = Math.max(24, width);
		const safeHeight = Math.max(24, height);
		const centeredPoint: ScenePoint = {
			x: point.x - safeWidth / 2,
			y: point.y - safeHeight / 2,
		};
		const image = createSceneElement(
			"image",
			centeredPoint,
			this.scene.appState.currentStyle,
			getMaxZIndex(this.scene.elements) + 1
		);
		image.fileId = fileEntry.id;
		image.width = safeWidth;
		image.height = safeHeight;
		image.aspectRatio = image.width / image.height;
		this.scene.elements.push(image);
		this.updateFrameMembership();
		this.selectOnly(image.id);
		this.commitHistory();
	}

	public addUrlCard(url: string, point: ScenePoint): boolean {
		const cleanUrl = url.trim();
		if (!/^https?:\/\/\S+$/i.test(cleanUrl)) {
			new Notice("Введи корректный URL, начинающийся с http:// или https://.");
			return false;
		}
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const card = createSceneElement(
			"note",
			point,
			this.scene.appState.currentStyle,
			getMaxZIndex(this.scene.elements) + 1
		);
		card.width = 260;
		card.height = 110;
		card.text = cleanUrl;
		card.link = cleanUrl;
		this.scene.elements.push(card);
		this.selectOnly(card.id);
		this.commitHistory();
		return true;
	}

	public addNoteLink(text: string, link: string, point: ScenePoint): void {
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const note = createSceneElement(
			"note",
			point,
			this.scene.appState.currentStyle,
			getMaxZIndex(this.scene.elements) + 1
		);
		note.text = text;
		note.link = link;
		this.scene.elements.push(note);
		this.selectOnly(note.id);
		this.commitHistory();
	}

	public destroy(): void {
		if (this.destroyed) return;
		if (this.textEditor.isOpen()) this.textEditor.close(true);
		this.finishInteraction();
		this.destroyed = true;
		this.doc.removeEventListener("paste", this.onPasteBound, true);
		this.doc.removeEventListener("copy", this.onCopyBound);
		this.doc.removeEventListener("cut", this.onCutBound);
		this.doc.removeEventListener("keydown", this.onDocKeyDownBound, true);
		this.win.removeEventListener("blur", this.onWindowBlurBound);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.renderer.destroy();
		this.root.remove();
	}

	private buildDOM(): void {
		this.host.replaceChildren();
		this.root = this.doc.createElement("div");
		this.root.className = "my-sc-canvas-editor";
		this.root.tabIndex = 0;
		this.host.appendChild(this.root);

		this.workspaceEl = this.doc.createElement("div");
		this.workspaceEl.className = "my-sc-canvas-workspace";
		this.root.appendChild(this.workspaceEl);

		this.canvasWrapEl = this.doc.createElement("div");
		this.canvasWrapEl.className = "my-sc-canvas-wrap";
		this.workspaceEl.appendChild(this.canvasWrapEl);

		this.canvasEl = this.doc.createElement("canvas");
		this.canvasEl.className = "my-sc-canvas-surface";
		this.canvasWrapEl.appendChild(this.canvasEl);

		this.toolbarEl = this.doc.createElement("div");
		this.toolbarEl.className = "my-sc-canvas-toolbar";
		this.canvasWrapEl.appendChild(this.toolbarEl);
		this.buildToolButtons();

		this.propertiesEl = this.doc.createElement("aside");
		this.propertiesEl.className = "my-sc-canvas-properties is-hidden";
		this.propertiesEl.setAttribute("aria-label", "Свойства выбранных элементов");
		this.canvasWrapEl.appendChild(this.propertiesEl);

		this.selectionBarEl = this.doc.createElement("div");
		this.selectionBarEl.className = "my-sc-canvas-selection-bar is-hidden";
		this.canvasWrapEl.appendChild(this.selectionBarEl);

		this.controlsEl = this.doc.createElement("div");
		this.controlsEl.className = "my-sc-canvas-controls";
		this.canvasWrapEl.appendChild(this.controlsEl);
		this.buildBottomControls();
		this.buildActionMenu();
		this.updatePropertiesPanel();
	}

	private buildToolButtons(): void {
		const lockButton = this.createButton(
			this.toolbarEl,
			this.scene.appState.keepToolActive ? "lock" : "unlock",
			"Не переключать инструмент (K)",
			() => this.toggleKeepToolActive(),
			"my-sc-canvas-lock"
		);
		lockButton.classList.toggle("is-active", this.scene.appState.keepToolActive);
		this.toolButtonById.clear();

		const tools: Array<{ id: CanvasToolId; icon: string; title: string }> = [
			{ id: "hand", icon: "hand", title: "Рука (H)" },
			{ id: "select", icon: "mouse-pointer-2", title: "Выбор (V / 1)" },
			{ id: "rectangle", icon: "rectangle-horizontal", title: "Прямоугольник (R)" },
			{ id: "diamond", icon: "diamond", title: "Ромб (D)" },
			{ id: "ellipse", icon: "circle", title: "Эллипс (O)" },
			{ id: "arrow", icon: "arrow-right", title: "Стрелка (A)" },
			{ id: "line", icon: "minus", title: "Линия (L)" },
			{ id: "freedraw", icon: "pencil", title: "Карандаш (P)" },
			{ id: "text", icon: "type", title: "Текст (T)" },
			{ id: "image", icon: "image", title: "Изображение (I)" },
			{ id: "note", icon: "sticky-note", title: "Заметка (N)" },
			{ id: "frame", icon: "frame", title: "Рамка" },
			{ id: "eraser", icon: "eraser", title: "Ластик (E)" },
		];

		for (const tool of tools) {
			const button = this.createButton(
				this.toolbarEl,
				tool.icon,
				tool.title,
				() => this.setTool(tool.id),
				"my-sc-canvas-tool"
			);
			button.dataset["tool"] = tool.id;
			this.toolButtonById.set(tool.id, button);
		}

		this.createButton(
			this.toolbarEl,
			"ellipsis",
			"Дополнительные действия",
			() => this.toggleActionMenu(),
			"my-sc-canvas-menu-trigger"
		);
		this.updateToolButtons();
	}

		private buildBottomControls(): void {
		const left = this.doc.createElement("div");
		left.className = "my-sc-canvas-controls-left";
		this.controlsEl.appendChild(left);

		this.createButton(left, "menu", "Меню холста", () => this.toggleActionMenu());
		this.propsToggleBtn = this.createButton(
			left,
			"palette",
			"Свойства выбранного элемента",
			() => this.togglePropertiesPanelVisibility()
		);
		this.undoBtn = this.createButton(left, "undo-2", "Отменить (Ctrl+Z)", () =>
			this.undo()
		);
		this.redoBtn = this.createButton(left, "redo-2", "Повторить (Ctrl+Y)", () =>
			this.redo()
		);

		const right = this.doc.createElement("div");
		right.className = "my-sc-canvas-controls-right";
		this.controlsEl.appendChild(right);
		this.createButton(right, "minus", "Отдалить", () => this.zoomByCenter(1 / 1.2));
		this.zoomLabelEl = this.createButton(right, "", "Масштаб", () =>
			this.fitToAll()
		);
		this.zoomLabelEl.classList.add("my-sc-canvas-zoom-label");
		this.zoomLabelEl.textContent = "100%";
		this.createButton(right, "plus", "Приблизить", () => this.zoomByCenter(1.2));
		this.createButton(right, "maximize", "Вписать всё", () => this.fitToAll());
		this.updateZoomLabel();
		this.updateHistoryButtons();
	}

	private buildActionMenu(): void {
		this.menuEl = this.doc.createElement("div");
		this.menuEl.className = "my-sc-canvas-menu";
		this.menuPanelEl = this.doc.createElement("div");
		this.menuPanelEl.className = "my-sc-canvas-menu-panel is-hidden";
		this.menuEl.appendChild(this.menuPanelEl);
		this.canvasWrapEl.appendChild(this.menuEl);

const actions: MenuAction[] = [
			{
				title: "Вставить из буфера",
				icon: "clipboard-paste",
				onClick: () => void this.pasteFromClipboard(),
			},
			{
				title: "Скопировать как PNG",
				icon: "image",
				onClick: () => void this.copySceneAsPng(),
			},
			{
				title: "Сохранить PNG в хранилище",
				icon: "download",
				onClick: () => void this.exportSceneAsPngToVault(),
			},
			{ title: "Вписать выделение", icon: "focus", onClick: () => this.fitToSelection() },
			{ title: "Выбрать всё", icon: "scan", onClick: () => this.selectAll() },
			{ title: "Дублировать", icon: "copy", onClick: () => this.duplicateSelection() },
			{
				title: "Копировать стиль (Ctrl+Alt+C)",
				icon: "pipette",
				onClick: () => this.copySelectedStyle(),
			},
			{
				title: "Вставить стиль (Ctrl+Alt+V)",
				icon: "paint-bucket",
				onClick: () => this.pasteSelectedStyle(),
			},
			{ title: "Сгруппировать", icon: "group", onClick: () => this.groupSelection() },
			{ title: "Разгруппировать", icon: "ungroup", onClick: () => this.ungroupSelection() },
			{ title: "Выровнять по левому краю", onClick: () => this.alignSelection("left") },
			{ title: "Выровнять по центру", onClick: () => this.alignSelection("center-x") },
			{ title: "Выровнять по правому краю", onClick: () => this.alignSelection("right") },
			{ title: "Выровнять по верхнему краю", onClick: () => this.alignSelection("top") },
			{ title: "Выровнять по середине", onClick: () => this.alignSelection("center-y") },
			{ title: "Выровнять по нижнему краю", onClick: () => this.alignSelection("bottom") },
			{ title: "Распределить по горизонтали", onClick: () => this.distributeSelection("horizontal") },
			{ title: "Распределить по вертикали", onClick: () => this.distributeSelection("vertical") },
			{ title: "На передний план", icon: "layers-2", onClick: () => this.changeLayerOrder("front") },
			{ title: "На задний план", icon: "layers", onClick: () => this.changeLayerOrder("back") },
		];

		for (const action of actions) {
			const button = this.doc.createElement("button");
			button.type = "button";
			button.className = "my-sc-canvas-menu-item";
			if (action.icon) setIcon(button, action.icon);
			const label = this.doc.createElement("span");
			label.textContent = action.title;
			button.appendChild(label);
			button.addEventListener("click", () => {
				action.onClick();
				this.hideActionMenu();
			});
			this.menuPanelEl.appendChild(button);
		}

		this.addMenuToggle("grid", "Показывать сетку", this.scene.appState.grid, (value) => {
			this.scene.appState.grid = value;
			this.notifySceneAndCameraChanged();
			this.renderFrame();
		});
		this.addMenuToggle("snapToGrid", "Привязка к сетке", this.scene.appState.snapToGrid, (value) => {
			this.scene.appState.snapToGrid = value;
			this.notifySceneAndCameraChanged();
		});
		this.addMenuToggle("snapToObjects", "Умные направляющие", this.scene.appState.snapToObjects, (value) => {
			this.scene.appState.snapToObjects = value;
			this.notifySceneAndCameraChanged();
		});
		this.addMenuToggle("theme", "Светлая тема", this.scene.appState.theme === "light", (value) => {
			const nextTheme = value ? "light" : "dark";
			this.recolorDefaultText(this.scene.appState.theme, nextTheme);
			this.scene.appState.theme = nextTheme;
			this.notifySceneAndCameraChanged();
			this.renderFrame();
		});
		this.addMenuToggle(
			"penOnly",
			"Только стилус (палец — панорама)",
			this.penOnlyMode,
			(value) => {
				this.togglePenOnlyMode(value);
			}
		);
	}

	private addMenuToggle(
		key: string,
		title: string,
		value: boolean,
		onChange: (next: boolean) => void
	): void {
		const label = this.doc.createElement("label");
		label.className = "my-sc-canvas-menu-toggle";
		const input = this.doc.createElement("input");
		input.type = "checkbox";
		input.checked = value;
		this.menuToggleByKey.set(key, input);
		input.addEventListener("change", () => onChange(input.checked));
		const span = this.doc.createElement("span");
		span.textContent = title;
		label.append(input, span);
		this.menuPanelEl.appendChild(label);
	}

	private updateMenuToggles(): void {
		const grid = this.menuToggleByKey.get("grid");
		if (grid) grid.checked = this.scene.appState.grid;
		const snapToGrid = this.menuToggleByKey.get("snapToGrid");
		if (snapToGrid) snapToGrid.checked = this.scene.appState.snapToGrid;
		const snapToObjects = this.menuToggleByKey.get("snapToObjects");
		if (snapToObjects) snapToObjects.checked = this.scene.appState.snapToObjects;
		const theme = this.menuToggleByKey.get("theme");
		if (theme) theme.checked = this.scene.appState.theme === "light";
		const penOnly = this.menuToggleByKey.get("penOnly");
		if (penOnly) penOnly.checked = this.penOnlyMode;
	}

	private createButton(
		parent: HTMLElement,
		icon: string,
		title: string,
		action: () => void,
		cls = "my-sc-canvas-control"
	): HTMLButtonElement {
		const button = this.doc.createElement("button");
		button.type = "button";
		button.className = cls;
		button.title = title;
		button.setAttribute("aria-label", title);
		if (icon) setIcon(button, icon);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			action();
			if (!this.destroyed) this.root.focus({ preventScroll: true });
		});
		parent.appendChild(button);
		return button;
	}

	private bindEvents(): void {
		this.canvasEl.addEventListener("pointerdown", this.onPointerDownBound);
		this.canvasEl.addEventListener("pointermove", this.onPointerMoveBound);
		this.canvasEl.addEventListener("pointerup", this.onPointerUpBound);
		this.canvasEl.addEventListener("pointercancel", this.onPointerUpBound);
		this.canvasEl.addEventListener("wheel", this.onWheelBound, { passive: false });
		this.canvasEl.addEventListener("dblclick", this.onDoubleClickBound);
		this.canvasEl.addEventListener("contextmenu", this.onContextMenuBound);
		this.root.addEventListener("keydown", this.onKeyDownBound);
		this.root.addEventListener("keyup", this.onKeyUpBound);
		this.doc.addEventListener("paste", this.onPasteBound, true);
		this.doc.addEventListener("copy", this.onCopyBound);
		this.doc.addEventListener("cut", this.onCutBound);
		this.doc.addEventListener("keydown", this.onDocKeyDownBound, true);
		this.canvasEl.addEventListener("dragover", this.onDragOverBound);
		this.canvasEl.addEventListener("drop", this.onDropBound);
		this.win.addEventListener("blur", this.onWindowBlurBound);

		if ("ResizeObserver" in this.win) {
			this.resizeObserver = new this.win.ResizeObserver(() => {
				this.resizeCanvas();
			});
			this.resizeObserver.observe(this.canvasWrapEl);
		}
	}

	private capturePointer(pointerId: number): void {
		this.canvasEl.setPointerCapture(pointerId);
	}

	private releasePointer(pointerId: number): void {
		if (this.canvasEl.hasPointerCapture(pointerId)) {
			this.canvasEl.releasePointerCapture(pointerId);
		}
	}

	private resizeCanvas(): void {
		if (this.destroyed || !this.renderer) return;
		const rect = this.canvasWrapEl.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		this.renderer.resizeCanvas(rect.width, rect.height);
		this.positionTextEditor();
		this.updateZoomLabel();
	}

	private renderFrame(): void {
		if (this.destroyed || !this.renderer) return;
		this.scene.elements.sort((a, b) => a.zIndex - b.zIndex);
		const payload: RenderFramePayload = {
			scene: this.scene,
			selectedIds: this.selectedIds,
			editingElementId: this.editingElementId,
			marqueeBox: this.marqueeBox,
			snapGuides: this.snapGuides,
			bindingHighlightElement: this.bindingHighlightElement,
			eraserTrail: this.eraserTrail,
			isDrawing: this.interaction?.kind === "create",
		};
		this.renderer.scheduleRender(payload);
		this.updateZoomLabel();
		this.updateSelectionFloatingBar();
	}

	private getWorldPoint(event: PointerEvent): ScenePoint {
		return pointerToWorld(event, this.canvasEl, this.scene.appState);
	}

	private getPasteWorldPoint(): ScenePoint {
		if (this.lastPointerWorld) {
			return { x: this.lastPointerWorld.x, y: this.lastPointerWorld.y };
		}
		return this.getViewportCenterWorld();
	}

	private getSelectedElements(): SceneElement[] {
		return this.scene.elements.filter(
			(element) => !element.isDeleted && this.selectedIds.has(element.id)
		);
	}

	private getElementById(id: string): SceneElement | undefined {
		return this.scene.elements.find((element) => element.id === id);
	}

	private getNextZIndex(): number {
		return getMaxZIndex(this.scene.elements) + 1;
	}

	private setTool(tool: CanvasToolId, persist = true): void {
		this.activeTool = tool;
		this.scene.appState.activeTool = tool;
		this.updateToolButtons();
		this.updateCursor();
		if (persist) this.notifySceneAndCameraChanged();
	}

	private updateToolButtons(): void {
		for (const [tool, button] of this.toolButtonById.entries()) {
			const active = tool === this.activeTool;
			button.classList.toggle("is-active", active);
			button.setAttribute("aria-pressed", String(active));
		}
		const lockButton = this.toolbarEl.querySelector<HTMLButtonElement>(
			".my-sc-canvas-lock"
		);
		if (lockButton) {
			lockButton.classList.toggle("is-active", this.scene.appState.keepToolActive);
			const label = this.scene.appState.keepToolActive
				? "Отключить фиксацию инструмента (K)"
				: "Не переключать инструмент (K)";
			lockButton.setAttribute("aria-label", label);
			lockButton.title = label;
			lockButton.replaceChildren();
			setIcon(lockButton, this.scene.appState.keepToolActive ? "lock" : "unlock");
		}
	}

	private updateCursor(): void {
		if (this.interaction?.kind === "pan") {
			this.canvasEl.style.cursor = "grabbing";
			return;
		}
		switch (this.activeTool) {
			case "hand":
				this.canvasEl.style.cursor = "grab";
				break;
			case "text":
				this.canvasEl.style.cursor = "text";
				break;
			case "image":
				this.canvasEl.style.cursor = "copy";
				break;
			case "eraser":
				this.canvasEl.style.cursor = "crosshair";
				break;
			case "select":
				this.canvasEl.style.cursor = "default";
				break;
			default:
				this.canvasEl.style.cursor = "crosshair";
		}
	}

	private toggleKeepToolActive(): void {
		this.scene.appState.keepToolActive = !this.scene.appState.keepToolActive;
		this.updateToolButtons();
		this.notifySceneAndCameraChanged();
	}

	private handlePointerDown(event: PointerEvent): void {
		if (this.destroyed) return;
		if (this.textEditor.isOpen()) this.textEditor.close(true);
		const world = this.getWorldPoint(event);
		this.lastPointerWorld = { x: world.x, y: world.y };
		if (event.button === 2) return;
		this.hideActionMenu();
		event.preventDefault();
		const screen = getCanvasPoint(event, this.canvasEl);
		this.activePointers.set(event.pointerId, screen);
		this.capturePointer(event.pointerId);

		if (this.activePointers.size >= 2) {
			this.startPinch();
			return;
		}

		this.root.focus({ preventScroll: true });
		const touchPanInPenMode =
			this.penOnlyMode && event.pointerType === "touch";
		if (
			event.button === 1 ||
			this.spacePressed ||
			this.activeTool === "hand" ||
			touchPanInPenMode
		) {
			this.interaction = {
				kind: "pan",
				pointerId: event.pointerId,
				startScreen: screen,
				lastScreen: screen,
				startWorld: world,
				didMove: false,
			};
			this.updateCursor();
			return;
		}
		if (event.button !== 0) return;

		if (this.activeTool === "image") {
			this.callbacks.onPickImage(world);
			if (!this.scene.appState.keepToolActive) this.setTool("select");
			return;
		}
		if (this.activeTool === "select") {
			this.beginSelectionInteraction(event, screen, world);
			return;
		}
		if (this.activeTool === "text") {
			this.beginTextAtPoint(world);
			return;
		}
		if (this.activeTool === "eraser") {
			const eraseInteraction = {
				kind: "erase" as const,
				pointerId: event.pointerId,
				startScreen: screen,
				startWorld: world,
				didErase: false,
			};
			this.interaction = eraseInteraction;
			this.eraserTrail = [world];
			eraseInteraction.didErase = this.eraseAt(world);
			this.renderFrame();
			return;
		}

		const elementType = getElementTypeForTool(this.activeTool);
		if (elementType) this.beginCreate(event, screen, world, elementType);
	}

	private beginSelectionInteraction(
		event: PointerEvent,
		screen: CanvasPoint,
		world: ScenePoint
	): void {
		const selectedElements = this.getSelectedElements();
		const handles = getTransformHandles(selectedElements, this.scene.appState.zoom);
		const hitHandle = hitTestHandles(handles, world, this.scene.appState.zoom);
		if (hitHandle) {
			this.beginHandleInteraction(event, screen, world, hitHandle);
			return;
		}

		const hit = getElementAtPoint(
			this.scene.elements,
			world,
			this.scene.appState.zoom
		);
		if (hit) {
			if (event.ctrlKey || event.metaKey) {
				const link = this.getElementLink(hit);
				if (link) {
					this.callbacks.onOpenLink(link, event.shiftKey);
					return;
				}
			}
			if (event.shiftKey) {
				if (this.selectedIds.has(hit.id)) {
					this.selectedIds.delete(hit.id);
				} else {
					this.addGroupedSelection(hit.id);
				}
			} else if (!this.selectedIds.has(hit.id)) {
				this.selectOnlyGroup(hit.id);
			}
			this.updatePropertiesPanel();
			this.renderFrame();

			if (this.selectedIds.has(hit.id) && !hit.locked) {
				const movable = this.getSelectedElements().filter(
					(element) => !element.locked
				);
				const movingIds = new Set(movable.map((element) => element.id));
				this.interaction = {
					kind: "move",
					pointerId: event.pointerId,
					startScreen: screen,
					startWorld: world,
					startElements: cloneElementMap(this.scene.elements, movingIds),
					movingIds,
					didMove: false,
					duplicateOnMove: event.altKey,
					started: false,
				};
			}
			return;
		}

		this.interaction = {
			kind: "marquee",
			pointerId: event.pointerId,
			startScreen: screen,
			startWorld: world,
			currentWorld: world,
			selectionBefore: new Set(this.selectedIds),
			additive: event.shiftKey,
		};
		if (!event.shiftKey) {
			this.selectedIds.clear();
			this.updatePropertiesPanel();
		}
		this.marqueeBox = this.makeAABB(world.x, world.y, world.x, world.y);
		this.renderFrame();
	}

	private beginHandleInteraction(
		event: PointerEvent,
		screen: CanvasPoint,
		world: ScenePoint,
		handle: HandleDescriptor
	): void {
		if (handle.kind === "point" || handle.kind === "midpoint") {
			const elementId = handle.elementId;
			const element = elementId ? this.getElementById(elementId) : undefined;
			if (!element || element.locked || !element.points) return;
			this.history.beginTransaction(this.scene.elements, this.selectedIds);
			const pointIndex = handle.pointIndex ?? 0;
			if (handle.kind === "midpoint") {
				const nextPoint = element.points[pointIndex];
				const previousPoint = element.points[pointIndex - 1];
				if (!nextPoint || !previousPoint) {
					this.history.cancelTransaction();
					return;
				}
				element.points.splice(pointIndex, 0, {
					x: (previousPoint.x + nextPoint.x) / 2,
					y: (previousPoint.y + nextPoint.y) / 2,
				});
				element.updated = Date.now();
			}
			this.interaction = {
				kind: "point",
				pointerId: event.pointerId,
				startScreen: screen,
				startWorld: world,
				elementId: element.id,
				pointIndex,
			};
			this.movePathPoint(element, pointIndex, world);
			this.renderFrame();
			return;
		}

		if (handle.kind === "rotate") {
			const bounds = getSelectionAABB(this.getSelectedElements());
			if (!bounds) return;
			this.history.beginTransaction(this.scene.elements, this.selectedIds);
			this.interaction = {
				kind: "rotate",
				pointerId: event.pointerId,
				startScreen: screen,
				startWorld: world,
				startElements: cloneElementMap(this.scene.elements, this.selectedIds),
				center: { x: bounds.cx, y: bounds.cy },
				startAngle: Math.atan2(world.y - bounds.cy, world.x - bounds.cx),
			};
			return;
		}

		if (!isResizeHandle(handle.kind)) return;
		const bounds = getSelectionAABB(this.getSelectedElements());
		if (!bounds) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		this.interaction = {
			kind: "resize",
			pointerId: event.pointerId,
			startScreen: screen,
			startWorld: world,
			startElements: cloneElementMap(this.scene.elements, this.selectedIds),
			startBounds: bounds,
			handle,
		};
	}

	private beginCreate(
		event: PointerEvent,
		screen: CanvasPoint,
		world: ScenePoint,
		type: SceneElement["type"]
	): void {
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const element = createSceneElement(
			type,
			world,
			this.scene.appState.currentStyle,
			this.getNextZIndex()
		);
		if (type === "freedraw") {
			element.points = [{ x: 0, y: 0, pressure: world.pressure }];
		}
		this.scene.elements.push(element);
		if (type === "freedraw") {
			this.selectedIds = new Set<string>();
		} else {
			this.selectOnly(element.id);
		}
		this.interaction = {
			kind: "create",
			pointerId: event.pointerId,
			startScreen: screen,
			startWorld: world,
			elementId: element.id,
			didMove: false,
		};
		this.updatePropertiesPanel();
		this.renderFrame();
	}

	private startPinch(): void {
		const points = Array.from(this.activePointers.values()).slice(-2);
		if (points.length < 2) return;
		this.finishInteractionForPinch();
		const center = getMidpoint(points[0]!, points[1]!);
		this.pinchState = {
			distance: Math.max(1, getDistance(points[0]!, points[1]!)),
			zoom: this.scene.appState.zoom,
			anchorWorld: canvasPointToWorld(center, this.scene.appState),
		};
		this.interaction = null;
	}

	private finishInteractionForPinch(): void {
		const current = this.interaction;
		if (!current) return;
		if (current.kind === "create" && !current.didMove) {
			this.scene.elements = this.scene.elements.filter(
				(element) => element.id !== current.elementId
			);
			this.selectedIds.delete(current.elementId);
			this.history.cancelTransaction();
		} else if (current.kind === "move" && !current.started) {
			this.interaction = null;
			return;
		} else if (current.kind !== "marquee" && current.kind !== "pan") {
			if (current.kind === "create") this.finalizeCreatedElement(current);
			this.commitHistory();
		}
		this.interaction = null;
	}

	private finalizeCreatedElement(
		interaction: Extract<PointerInteraction, { kind: "create" }>
	): void {
		const element = this.getElementById(interaction.elementId);
		if (element) {
			finalizeElementSize(element, interaction.startWorld, interaction.didMove);
		}
	}

	private handlePointerMove(event: PointerEvent): void {
		if (this.destroyed) return;
		const screen = getCanvasPoint(event, this.canvasEl);
		const world = this.getWorldPoint(event);
		if (!this.menuPanelEl || this.menuPanelEl.classList.contains("is-hidden")) {
			this.lastPointerWorld = { x: world.x, y: world.y };
		}
		if (this.activePointers.has(event.pointerId)) {
			this.activePointers.set(event.pointerId, screen);
		}
		if (this.activePointers.size >= 2 && this.pinchState) {
			this.updatePinch();
			return;
		}

		const current = this.interaction;
		if (!current || current.pointerId !== event.pointerId) {
			this.updateBindingPreview(world);
			return;
		}
		const screenDistance = getDistance(current.startScreen, screen);
		if (screenDistance > 3 && current.kind !== "pan") {
			if (current.kind === "create") current.didMove = true;
			if (current.kind === "move") current.didMove = true;
		}

		switch (current.kind) {
			case "pan":
				this.panByScreenDelta(
					screen.x - current.lastScreen.x,
					screen.y - current.lastScreen.y
				);
				current.lastScreen = screen;
				current.didMove = current.didMove || screenDistance > 1;
				break;
			case "create":
				this.updateCreation(current, world, event);
				break;
			case "move":
				this.updateMove(current, world);
				break;
			case "resize":
				this.updateResize(current, world, event.shiftKey);
				break;
			case "rotate":
				this.updateRotation(current, world, event.shiftKey);
				break;
			case "point": {
				const element = this.getElementById(current.elementId);
				if (element) this.movePathPoint(element, current.pointIndex, world);
				this.renderFrame();
				break;
			}
			case "marquee":
				current.currentWorld = world;
				this.marqueeBox = this.makeAABB(
					current.startWorld.x,
					current.startWorld.y,
					world.x,
					world.y
				);
				this.renderFrame();
				break;
			case "erase":
				current.didErase = this.eraseAt(world) || current.didErase;
				this.eraserTrail.push(world);
				this.renderFrame();
				break;
		}
	}

	private handlePointerUp(event: PointerEvent): void {
		const wasPinching = this.pinchState !== null;
		this.activePointers.delete(event.pointerId);
		this.releasePointer(event.pointerId);
		if (wasPinching) {
			if (this.activePointers.size < 2) this.pinchState = null;
			return;
		}

		const current = this.interaction;
		if (!current || current.pointerId !== event.pointerId) return;
		const world = this.getWorldPoint(event);
		switch (current.kind) {
			case "create":
				this.finishCreation(current, world, event.shiftKey, event.altKey);
				break;
			case "move":
				if (current.started) this.commitHistory();
				break;
			case "resize":
			case "rotate":
				this.commitHistory();
				break;
			case "point":
				this.bindEditedEndpoint(current);
				this.commitHistory();
				break;
			case "marquee":
				this.finishMarquee(current);
				break;
			case "erase":
				if (current.didErase) this.commitHistory();
				break;
		}
		this.interaction = null;
		this.marqueeBox = null;
		this.snapGuides = [];
		this.bindingHighlightElement = null;
		this.eraserTrail = [];
		const keepsPencil =
			current.kind === "create" && this.activeTool === "freedraw";
		if (
			(current.kind === "create" || current.kind === "erase") &&
			!this.scene.appState.keepToolActive &&
			!keepsPencil
		) {
			this.setTool("select");
		}
		this.updateCursor();
		this.updatePropertiesPanel();
		this.renderFrame();
	}

	private handleWheel(event: WheelEvent): void {
		event.preventDefault();
		const point = getCanvasPoint(event, this.canvasEl);
		if (event.ctrlKey || event.metaKey) {
			this.zoomAt(point, Math.exp(-event.deltaY * 0.002));
			return;
		}
		const zoom = Math.max(0.1, this.scene.appState.zoom);
		this.scene.appState.scrollX -= event.deltaX / zoom;
		this.scene.appState.scrollY -= event.deltaY / zoom;
		this.notifySceneAndCameraChanged();
		this.positionTextEditor();
		this.renderFrame();
	}

	private handleKeyDown(event: KeyboardEvent): void {
		if (this.destroyed) return;
		if (event.code === "Space" && !isEditableTarget(event.target)) {
			event.preventDefault();
			this.spacePressed = true;
			this.canvasEl.style.cursor = "grab";
			return;
		}
		if (isEditableTarget(event.target)) return;

		if (this.isPasteShortcut(event)) {
			event.preventDefault();
			void this.pasteFromClipboard();
			return;
		}

		const tool = getToolForKey(event);
		if (tool) {
			event.preventDefault();
			this.setTool(tool);
			return;
		}

		const command = getCanvasCommand(event);
		if (!command) return;
		if (this.executeCommand(command, event)) event.preventDefault();
	}

	private handleDocumentKeyDown(event: KeyboardEvent): void {
		if (!this.isPasteShortcut(event)) return;
		if (!this.isCanvasPasteContextActive(event.target)) return;
		this.root.focus({ preventScroll: true });
		this.win.setTimeout(() => {
			if (!this.destroyed) {
				void this.pasteFromClipboard();
			}
		}, 20);
	}

	private isPasteShortcut(event: KeyboardEvent): boolean {
		if (event.isComposing) return false;
		const mod = event.ctrlKey || event.metaKey;
		if (
			mod &&
			!event.altKey &&
			(event.code === "KeyV" || event.key.toLowerCase() === "v")
		) {
			return true;
		}
		if (
			event.shiftKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			(event.code === "Insert" || event.key === "Insert")
		) {
			return true;
		}
		return false;
	}

	private isCanvasPasteContextActive(target: EventTarget | null): boolean {
		if (this.destroyed || !this.root || !this.root.isConnected) return false;
		if (this.textEditor.isOpen()) return false;
		if (isEditableTarget(target) || isEditableTarget(this.doc.activeElement)) {
			return false;
		}
		if (target instanceof Node && this.isInsideExternalInputOrModal(target)) {
			return false;
		}
		const activeEl = this.doc.activeElement;
		if (activeEl instanceof Node && this.isInsideExternalInputOrModal(activeEl)) {
			return false;
		}

		const rect = this.root.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;

		const myLeaf = this.root.closest(".workspace-leaf");
		if (myLeaf) {
			const activeLeaf = this.doc.querySelector(".workspace-leaf.mod-active");
			if (activeLeaf && activeLeaf !== myLeaf && !myLeaf.contains(activeEl)) {
				return false;
			}
		}

		if (
			!activeEl ||
			activeEl === this.doc.body ||
			activeEl === this.doc.documentElement
		) {
			return true;
		}
		if (this.root.contains(activeEl) || activeEl.contains(this.root)) {
			return true;
		}
		const hostContainer = this.root.closest(
			".my-sc-workspace-root, .my-sc-schema-host, .modal.my-sc-modal-container"
		);
		return Boolean(hostContainer && hostContainer.contains(activeEl));
	}

	private isInsideExternalInputOrModal(node: Node): boolean {
		const el = node instanceof HTMLElement ? node : node.parentElement;
		if (!el) return false;
		if (el.closest("input, textarea, select, [contenteditable='true']")) {
			return true;
		}
		const modal = el.closest(".modal-container, .prompt");
		if (modal && !modal.contains(this.root)) {
			return true;
		}
		return false;
	}

	private handleKeyUp(event: KeyboardEvent): void {
		if (event.code !== "Space") return;
		this.spacePressed = false;
		this.updateCursor();
	}

	private executeCommand(command: CanvasCommand, event: KeyboardEvent): boolean {
		switch (command) {
			case "undo":
				this.undo();
				return true;
			case "redo":
				this.redo();
				return true;
			case "select-all":
				this.selectAll();
				return true;
			case "duplicate":
				this.duplicateSelection();
				return true;
			case "group":
				this.groupSelection();
				return true;
			case "ungroup":
				this.ungroupSelection();
				return true;
			case "delete":
				this.deleteSelection();
				return true;
			case "move-left":
				this.moveSelectionBy(event.shiftKey ? -10 : -1, 0);
				return true;
			case "move-right":
				this.moveSelectionBy(event.shiftKey ? 10 : 1, 0);
				return true;
			case "move-up":
				this.moveSelectionBy(0, event.shiftKey ? -10 : -1);
				return true;
			case "move-down":
				this.moveSelectionBy(0, event.shiftKey ? 10 : 1);
				return true;
			case "bring-forward":
				this.changeLayerOrder("forward");
				return true;
			case "send-backward":
				this.changeLayerOrder("backward");
				return true;
			case "bring-to-front":
				this.changeLayerOrder("front");
				return true;
			case "send-to-back":
				this.changeLayerOrder("back");
				return true;
			case "toggle-keep-tool":
				this.toggleKeepToolActive();
				return true;
			case "copy-style":
				this.copySelectedStyle();
				return true;
			case "paste-style":
				this.pasteSelectedStyle();
				return true;
			case "escape":
				if (this.menuPanelEl && !this.menuPanelEl.classList.contains("is-hidden")) {
					this.hideActionMenu();
				} else if (this.textEditor.isOpen()) {
					this.textEditor.close(true);
				} else if (this.interaction?.kind === "create") {
					const current = this.interaction;
					this.scene.elements = this.scene.elements.filter(
						(element) => element.id !== current.elementId
					);
					this.history.cancelTransaction();
					this.selectedIds.delete(current.elementId);
					this.releasePointer(current.pointerId);
					this.activePointers.delete(current.pointerId);
					this.interaction = null;
					this.setTool("select");
					this.updatePropertiesPanel();
					this.renderFrame();
				} else if (this.interaction) {
					this.finishInteraction();
					this.setTool("select");
				} else {
					this.selectedIds.clear();
					if (this.activeTool !== "select") this.setTool("select");
					this.updatePropertiesPanel();
					this.renderFrame();
				}
				return true;
		}
	}

	private handleCopy(event: ClipboardEvent): void {
		if (!this.isCanvasPasteContextActive(event.target)) return;
		this.copySelectionToClipboard(event);
	}

	private handleCut(event: ClipboardEvent): void {
		if (!this.isCanvasPasteContextActive(event.target)) return;
		if (this.copySelectionToClipboard(event)) this.deleteSelection();
	}

	private copySelectionToClipboard(event: ClipboardEvent): boolean {
		const clipboard = event.clipboardData;
		const selected = this.getSelectedElements();
		if (!clipboard || selected.length === 0) return false;
		const elements = selected.map((element) => cloneSceneElement(element));
		const payload = JSON.stringify({ source: "my-study-compiler", elements });
		event.preventDefault();
		try {
			clipboard.setData("application/x-my-study-compiler-scene", payload);
		} catch {
			// Fallback to text/plain
		}
		const plainText =
			selected.length === 1 && selected[0]?.type === "text"
				? getTextValue(selected[0])
				: `${SCENE_CLIPBOARD_PREFIX}${payload}`;
		clipboard.setData("text/plain", plainText);
		return true;
	}

	private handlePaste(event: ClipboardEvent): void {
		if (!this.isCanvasPasteContextActive(event.target)) return;
		event.preventDefault();
		event.stopPropagation();
		void this.pasteFromClipboard(event.clipboardData);
	}

	private async pasteFromClipboard(
		clipboardData?: DataTransfer | null,
		targetPoint?: ScenePoint
	): Promise<void> {
		const now = Date.now();
		if (this.isPasting || now - this.lastPasteAt < 120) return;
		this.isPasting = true;
		this.lastPasteAt = now;
		const point = targetPoint
			? { x: targetPoint.x, y: targetPoint.y }
			: this.getPasteWorldPoint();

		try {
			// 1. Чтение через ClipboardEvent (DataTransfer)
			if (clipboardData) {
				const eventFile = this.extractImageFileFromDataTransfer(clipboardData);
				if (eventFile) {
					await this.callbacks.onPasteImage(eventFile, point);
					return;
				}
				const custom = clipboardData.getData("application/x-my-study-compiler-scene");
				const plainText = clipboardData.getData("text/plain");
				if (this.tryPasteScenePayload(custom, plainText)) {
					return;
				}
			}

			// 2. Чтение через стандартный Web API navigator.clipboard.read()
			const navigatorFile = await this.readImageFromNavigatorClipboard();
			if (navigatorFile) {
				await this.callbacks.onPasteImage(navigatorFile, point);
				return;
			}

			// 3. Чтение через системный буфер Electron (clipboard.readImage())
			const electronFile = this.readImageFromElectronClipboard();
			if (electronFile) {
				await this.callbacks.onPasteImage(electronFile, point);
				return;
			}

			// 4. Вставка элементов сцены или обычного текста из буфера
			const text =
				(clipboardData ? clipboardData.getData("text/plain") : "") ||
				(await this.readTextFromClipboard());
			if (text) {
				if (this.tryPasteScenePayload("", text)) {
					return;
				}
				if (text.trim()) {
					this.addTextFromString(text, point, true);
				}
			}
		} catch (error: unknown) {
			this.reportAsyncError(error);
		} finally {
			this.isPasting = false;
			this.lastPasteAt = Date.now();
		}
	}

	private extractImageFileFromDataTransfer(
		clipboard: DataTransfer
	): File | null {
		if (clipboard.items) {
			for (const item of Array.from(clipboard.items)) {
				if (item.kind === "file" && item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) return file;
				}
			}
		}
		if (clipboard.files) {
			for (const file of Array.from(clipboard.files)) {
				if (
					file.type.startsWith("image/") ||
					/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name)
				) {
					return file;
				}
			}
		}
		return null;
	}

	private async readImageFromNavigatorClipboard(): Promise<File | null> {
		try {
			const nav = this.win.navigator as Navigator & {
				clipboard?: AsyncClipboardLike;
			};
			const clipboard = nav?.clipboard;
			if (!clipboard || typeof clipboard.read !== "function") return null;
			const items = await clipboard.read();
			for (const item of items) {
				const imageType = item.types.find((type) =>
					type.toLowerCase().startsWith("image/")
				);
				if (!imageType) continue;
				const blob = await item.getType(imageType);
				if (blob && blob.size > 0) {
					const ext = imageType.split("/")[1]?.split("+")[0] || "png";
					return new File([blob], `clipboard-${Date.now()}.${ext}`, {
						type: imageType,
					});
				}
			}
		} catch {
			// Переходим к чтению системного буфера Electron
		}
		return null;
	}

	private getElectronClipboard(): ElectronClipboardLike | null {
		try {
			const winWithRequire = this.win as Window &
				typeof globalThis & {
					require?: (moduleId: string) => unknown;
				};
			const req =
				typeof winWithRequire.require === "function"
					? winWithRequire.require
					: null;
			if (!req) return null;
			const electronModule = req("electron") as {
				clipboard?: ElectronClipboardLike;
			} | null;
			return electronModule?.clipboard ?? null;
		} catch {
			return null;
		}
	}

	private readImageFromElectronClipboard(): File | null {
		try {
			const clipboard = this.getElectronClipboard();
			if (!clipboard || typeof clipboard.readImage !== "function") return null;
			const image = clipboard.readImage();
			if (!image || image.isEmpty()) return null;
			const pngBytes = image.toPNG();
			if (!pngBytes || pngBytes.byteLength === 0) return null;
			const bufferCopy = new Uint8Array(pngBytes.byteLength);
			bufferCopy.set(pngBytes);
			return new File([bufferCopy], `clipboard-${Date.now()}.png`, {
				type: "image/png",
			});
		} catch {
			return null;
		}
	}

	private async readTextFromClipboard(): Promise<string> {
		try {
			const nav = this.win.navigator as Navigator & {
				clipboard?: AsyncClipboardLike;
			};
			if (nav?.clipboard && typeof nav.clipboard.readText === "function") {
				const text = await nav.clipboard.readText();
				if (text) return text;
			}
		} catch {
			// Переходим к чтению текста через Electron
		}
		try {
			const clipboard = this.getElectronClipboard();
			if (clipboard && typeof clipboard.readText === "function") {
				return clipboard.readText() || "";
			}
		} catch {
			// Игнорируем ошибку
		}
		return "";
	}

	private tryPasteScenePayload(custom: string, plainText: string): boolean {
		const serialized = custom || this.stripClipboardPrefix(plainText);
		if (!serialized) return false;
		const parsed = this.parseClipboardScene(serialized);
		if (parsed) {
			this.pasteElements(parsed);
			return true;
		}
		if (plainText.startsWith(SCENE_CLIPBOARD_PREFIX)) {
			new Notice("Не удалось вставить: данные холста повреждены.");
			return true;
		}
		return false;
	}

	private stripClipboardPrefix(value: string): string {
		return value.startsWith(SCENE_CLIPBOARD_PREFIX)
			? value.slice(SCENE_CLIPBOARD_PREFIX.length)
			: "";
	}

	private parseClipboardScene(value: string): SceneElement[] | null {
		try {
			const parsed: unknown = JSON.parse(value);
			if (!parsed || typeof parsed !== "object") return null;
			const rawElements = (parsed as { elements?: unknown }).elements;
			if (!Array.isArray(rawElements)) return null;
			return rawElements.filter(
				(element): element is SceneElement =>
					Boolean(
						element &&
							typeof element === "object" &&
							typeof (element as SceneElement).id === "string" &&
							typeof (element as SceneElement).type === "string"
					)
			);
		} catch {
			return null;
		}
	}

	private pasteElements(source: readonly SceneElement[]): void {
		if (source.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const idMap = new Map<string, string>();
		const groupMap = new Map<string, string>();
		for (const element of source) idMap.set(element.id, generateElementId(element.type));
		for (const element of source) {
			for (const groupId of element.groupIds ?? []) {
				if (!groupMap.has(groupId)) groupMap.set(groupId, generateElementId("group"));
			}
		}
		const offset = 24 / Math.max(0.1, this.scene.appState.zoom);
		const copies = source.map((original): SceneElement => {
			const copy = cloneSceneElement(original);
			copy.id = idMap.get(original.id) ?? generateElementId(original.type);
			copy.x += offset;
			copy.y += offset;
			copy.zIndex = this.getNextZIndex() + source.indexOf(original);
			copy.updated = Date.now();
			copy.groupIds = (copy.groupIds ?? []).map(
				(groupId) => groupMap.get(groupId) ?? groupId
			);
			copy.containerId = copy.containerId
				? idMap.get(copy.containerId) ?? null
				: null;
			copy.boundTextId = copy.boundTextId
				? idMap.get(copy.boundTextId) ?? null
				: null;
			copy.frameId = copy.frameId ? idMap.get(copy.frameId) ?? null : null;
			if (copy.startBinding) {
				copy.startBinding.elementId =
					idMap.get(copy.startBinding.elementId) ?? copy.startBinding.elementId;
			}
			if (copy.endBinding) {
				copy.endBinding.elementId =
					idMap.get(copy.endBinding.elementId) ?? copy.endBinding.elementId;
			}
			return copy;
		});
		this.scene.elements.push(...copies);
		this.selectedIds = new Set(copies.map((element) => element.id));
		updateBoundElements(this.scene.elements);
		this.commitHistory();
	}

	private handleDragOver(event: DragEvent): void {
		if (!event.dataTransfer) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	}

	private handleDrop(event: DragEvent): void {
		const transfer = event.dataTransfer;
		if (!transfer) return;
		event.preventDefault();
		const point = this.getDropWorldPoint(event);
		this.lastPointerWorld = { x: point.x, y: point.y };
		const files = Array.from(transfer.files);
		if (files.length > 0) {
			for (const file of files) {
				if (file.type.startsWith("image/")) {
					void this.callbacks
						.onPasteImage(file, point)
						.catch((error: unknown) => this.reportAsyncError(error));
				} else if (file.name.toLowerCase().endsWith(".md")) {
					const title = file.name.replace(/\.md$/i, "");
					this.addNoteLink(title, `[[${title}]]`, point);
				} else {
					this.addNoteLink(file.name, "", point);
				}
			}
			return;
		}

		const text = transfer.getData("text/plain").trim();
		if (/^https?:\/\/\S+$/i.test(text)) {
			this.addUrlCard(text, point);
		} else if (/^\[\[[^\]]+\]\]$/.test(text)) {
			const target = text.slice(2, -2).split("|")[0]?.split("#")[0]?.trim();
			if (target) this.addNoteLink(target, text, point);
		} else if (/\.md$/i.test(text)) {
			const title = text.replace(/\\/g, "/").split("/").pop()?.replace(/\.md$/i, "");
			if (title) this.addNoteLink(title, `[[${title}]]`, point);
		} else if (text) {
			this.addTextFromString(text, point, false);
		}
	}

	private handleDoubleClick(event: MouseEvent): void {
		if (this.destroyed || this.textEditor.isOpen()) return;
		if (this.activeTool !== "select" && this.activeTool !== "text") return;
		const point = canvasPointToWorld(
			{ x: event.offsetX, y: event.offsetY },
			this.scene.appState
		);
		this.lastPointerWorld = { x: point.x, y: point.y };
		const element = getElementAtPoint(
			this.scene.elements,
			point,
			this.scene.appState.zoom
		);
		if (!element) {
			this.createTextElement(point);
			return;
		}
		if (element.type === "text" || element.type === "note") {
			this.selectOnlyGroup(element.id);
			this.updatePropertiesPanel();
			this.beginTextEditing(element, false);
			return;
		}
		if (isTextContainer(element)) this.beginContainerTextEditing(element);
	}

	private handleContextMenu(event: MouseEvent): void {
		event.preventDefault();
		const point = canvasPointToWorld(
			{ x: event.offsetX, y: event.offsetY },
			this.scene.appState
		);
		this.lastPointerWorld = { x: point.x, y: point.y };
		this.root.focus({ preventScroll: true });
		const element = getElementAtPoint(
			this.scene.elements,
			point,
			this.scene.appState.zoom
		);
		if (element) {
			if (!this.selectedIds.has(element.id)) this.selectOnlyGroup(element.id);
			this.updatePropertiesPanel();
			this.renderFrame();
		}
		this.toggleActionMenu();
	}

	private handleWindowBlur(): void {
		this.spacePressed = false;
		if (this.textEditor.isOpen()) this.textEditor.close(true);
		this.finishInteraction();
		this.activePointers.clear();
		this.pinchState = null;
		this.updateCursor();
	}

	private getMeasureCtx(): CanvasRenderingContext2D | null {
		return getMeasureContext(this.doc);
	}

	private getNewTextColor(): string {
		const style = this.scene.appState.currentStyle;
		if (
			style.strokeColor &&
			style.strokeColor !== DEFAULT_ELEMENT_STYLE.strokeColor
		) {
			return style.strokeColor;
		}
		return getDefaultTextColor(this.scene.appState.theme);
	}

	private getTextColor(element: SceneElement): string {
		const fallback = getDefaultTextColor(this.scene.appState.theme);
		return element.type === "text" ? element.strokeColor || fallback : fallback;
	}

	private getTextContainer(element: SceneElement): SceneElement | null {
		if (element.type !== "text") return element;
		return element.containerId
			? this.getElementById(element.containerId) ?? null
			: null;
	}

	private makeTextElement(point: ScenePoint): SceneElement {
		const element = createSceneElement(
			"text",
			point,
			this.scene.appState.currentStyle,
			this.getNextZIndex()
		);
		element.strokeColor = this.getNewTextColor();
		element.text = "";
		return element;
	}

	private beginTextAtPoint(world: ScenePoint): void {
		const hit = getElementAtPoint(
			this.scene.elements,
			world,
			this.scene.appState.zoom
		);
		if (hit && (hit.type === "text" || hit.type === "note")) {
			this.selectOnlyGroup(hit.id);
			this.updatePropertiesPanel();
			this.beginTextEditing(hit, false);
		} else if (hit && isTextContainer(hit)) {
			this.beginContainerTextEditing(hit);
		} else {
			this.createTextElement(world);
		}
	}

	private beginContainerTextEditing(container: SceneElement): void {
		const bound = container.boundTextId
			? this.getElementById(container.boundTextId)
			: this.scene.elements.find(
					(item) => !item.isDeleted && item.containerId === container.id
			  );
		if (bound && !bound.isDeleted) {
			this.selectOnlyGroup(container.id);
			this.updatePropertiesPanel();
			this.beginTextEditing(bound, false);
			return;
		}
		if (container.text) {
			this.selectOnlyGroup(container.id);
			this.updatePropertiesPanel();
			this.beginTextEditing(container, false);
			return;
		}

		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const text = this.makeTextElement({ x: container.x, y: container.y });
		const box = getContainerTextBox(container);
		text.containerId = container.id;
		text.textAlign = "center";
		text.verticalAlign = "middle";
		text.autoResize = false;
		text.x = box.x;
		text.y = box.y;
		text.width = box.width;
		text.height = box.height;
		text.angle = container.angle;
		container.boundTextId = text.id;
		this.scene.elements.push(text);
		this.selectOnlyGroup(container.id);
		this.updatePropertiesPanel();
		this.beginTextEditing(text, true, true);
	}

	private beginTextEditing(
		element: SceneElement,
		isNew: boolean,
		transactionAlreadyStarted = false
	): void {
		if (this.textEditor.isOpen()) this.textEditor.close(true);
		if (!transactionAlreadyStarted) {
			this.history.beginTransaction(this.scene.elements, this.selectedIds);
		}
		this.textEditSession = {
			elementId: element.id,
			isNew,
			anchor: getTextAnchor(element),
		};
		this.editingElementId = element.id;
		this.textEditor.open({
			initialText: getTextValue(element),
			fontFamily: element.fontFamily,
			textAlign: element.textAlign,
			color: this.getTextColor(element),
			computeLayout: (value) => this.computeTextEditorLayout(element.id, value),
			onCommit: (value, reason) => this.finishTextEditing(value, reason),
			onWheel: (event) => this.handleWheel(event),
		});
		this.renderFrame();
	}

	private createTextElement(point: ScenePoint): void {
		if (this.textEditor.isOpen()) this.textEditor.close(true);
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const element = this.makeTextElement(point);
		element.width = 0;
		element.x = point.x;
		element.y = point.y - element.height / 2;
		this.scene.elements.push(element);
		this.selectOnly(element.id);
		this.beginTextEditing(element, true, true);
	}

	private addTextFromString(
		text: string,
		point: ScenePoint,
		centered: boolean
	): void {
		const value = text.replace(/\r\n?/g, "\n");
		const ctx = this.getMeasureCtx();
		if (!value.trim() || !ctx) return;
		if (this.textEditor.isOpen()) this.textEditor.close(true);
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const element = this.makeTextElement(point);
		element.text = value;
		this.updateLinkFromText(element);
		fitTextElementToContent(ctx, element);
		element.x = centered ? point.x - element.width / 2 : point.x;
		element.y = centered ? point.y - element.height / 2 : point.y;
		this.scene.elements.push(element);
		this.selectOnly(element.id);
		this.commitHistory();
	}

	private computeTextEditorLayout(
		elementId: string,
		value: string
	): TextEditorLayout | null {
		const element = this.getElementById(elementId);
		const ctx = this.getMeasureCtx();
		if (!element || !ctx) return null;
		const { scrollX, scrollY } = this.scene.appState;
		const zoom = Math.max(0.1, this.scene.appState.zoom);
		const container = this.getTextContainer(element);

		if (!container) {
			const wrapWidth =
				element.autoResize === true ? null : getTextWrapWidth(element.width);
			const metrics = measureTextBlock(
				ctx,
				value,
				element.fontSize,
				element.fontFamily,
				wrapWidth
			);
			const session = this.textEditSession;
			const x =
				wrapWidth === null && session
					? getAnchoredTextX(session.anchor, element.textAlign, metrics.width)
					: element.x;
			const offsetY = getTextOffsetY(
				element.verticalAlign,
				wrapWidth === null ? metrics.height : element.height,
				metrics.height
			);
			return {
				left: (x + scrollX) * zoom,
				top: (element.y + offsetY + scrollY) * zoom,
				width: metrics.width * zoom,
				height: metrics.height * zoom,
				fontSize: metrics.fontSize * zoom,
				wrap: wrapWidth !== null,
				angle: element.angle || 0,
			};
		}

		const box = getContainerTextBox(container);
		const metrics = measureTextBlock(
			ctx,
			value,
			element.fontSize,
			element.fontFamily,
			box.width
		);
		const offsetY = getTextOffsetY(
			element.verticalAlign,
			box.height,
			metrics.height
		);
		const left = (box.x + scrollX) * zoom;
		const top = (box.y + offsetY + scrollY) * zoom;
		return {
			left,
			top,
			width: box.width * zoom,
			height: metrics.height * zoom,
			fontSize: metrics.fontSize * zoom,
			wrap: true,
			angle: container.angle || 0,
			originX: (container.x + container.width / 2 + scrollX) * zoom - left,
			originY: (container.y + container.height / 2 + scrollY) * zoom - top,
		};
	}

	private finishTextEditing(value: string, reason: TextEditorCloseReason): void {
		const session = this.textEditSession;
		if (!session) return;
		const element = this.getElementById(session.elementId);
		this.editingElementId = null;
		this.textEditSession = null;
		if (!element) {
			this.history.cancelTransaction();
			this.renderFrame();
			return;
		}

		if (element.type === "text" && !value.trim()) {
			this.removeElementAndUnbind(element);
			if (session.isNew) this.history.cancelTransaction();
			else this.commitHistory();
		} else if (!session.isNew && value === getTextValue(element)) {
			this.history.cancelTransaction();
		} else {
			element.text = value;
			this.updateLinkFromText(element);
			const ctx = this.getMeasureCtx();
			if (ctx) fitTextElementToContent(ctx, element, session.anchor);
			element.updated = Date.now();
			updateBoundElements(this.scene.elements);
			this.updateFrameMembership();
			this.commitHistory();
		}
		this.updatePropertiesPanel();
		if (!this.scene.appState.keepToolActive) this.setTool("select");
		else this.renderFrame();
		if (reason === "keyboard" && !this.destroyed) {
			this.root.focus({ preventScroll: true });
		}
	}

	private recolorDefaultText(from: "dark" | "light", to: "dark" | "light"): void {
		if (from === to) return;
		const previous = getDefaultTextColor(from).toLowerCase();
		const next = getDefaultTextColor(to);
		for (const element of this.scene.elements) {
			if (
				element.type === "text" &&
				element.strokeColor?.toLowerCase() === previous
			) {
				element.strokeColor = next;
			}
		}
	}

	private applyTextGeometry(element: SceneElement, geometry: TextGeometry): void {
		element.x = geometry.x;
		element.y = geometry.y;
		element.width = geometry.width;
		element.height = geometry.height;
		element.fontSize = geometry.fontSize;
		element.autoResize = geometry.autoResize;
		element.updated = Date.now();
	}

	private removeElementAndUnbind(element: SceneElement): void {
		this.scene.elements = this.scene.elements.filter(
			(item) => item.id !== element.id
		);
		if (element.containerId) {
			const parent = this.getElementById(element.containerId);
			if (parent?.boundTextId === element.id) parent.boundTextId = null;
		}
		this.selectedIds.delete(element.id);
	}

	private positionTextEditor(): void {
		this.textEditor.reposition();
	}

	private updateLinkFromText(element: SceneElement): void {
		const match = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/.exec(
			element.text ?? ""
		);
		if (match?.[1]) {
			element.link = `[[${match[1].trim()}]]`;
		} else if (element.link?.startsWith("[[")) {
			element.link = null;
		}
	}

	private getElementLink(element: SceneElement): string | null {
		if (element.link) return element.link;
		const boundText = element.boundTextId
			? this.getElementById(element.boundTextId)
			: this.scene.elements.find((candidate) => candidate.containerId === element.id);
		return boundText?.link ?? null;
	}

	private updateCreation(
		interaction: Extract<PointerInteraction, { kind: "create" }>,
		world: ScenePoint,
		event: PointerEvent
	): void {
		const element = this.getElementById(interaction.elementId);
		if (!element) return;
		if (element.type === "freedraw") {
			appendFreedrawPoint(element, world);
		} else {
			updateElementFromDrag(element, interaction.startWorld, world, {
				shift: event.shiftKey,
				alt: event.altKey,
			});
		}
		if (element.type === "arrow" || element.type === "line") {
			this.updateBindingPreview(world);
		}
		this.renderFrame();
	}

	private finishCreation(
		interaction: Extract<PointerInteraction, { kind: "create" }>,
		world: ScenePoint,
		shiftKey: boolean,
		altKey: boolean
	): void {
		const element = this.getElementById(interaction.elementId);
		if (!element) {
			this.history.cancelTransaction();
			return;
		}
		if (element.type === "freedraw") {
			appendFreedrawPoint(element, world);
			normalizeElementBounds(element);
		} else if (element.type === "arrow" || element.type === "line") {
			if (!interaction.didMove) {
				finalizeElementSize(element, interaction.startWorld, false);
			} else {
				updateElementFromDrag(element, interaction.startWorld, world, {
					shift: shiftKey,
					alt: altKey,
				});
			}
			const startMatch = findNearestBindingTarget(
				interaction.startWorld,
				this.scene.elements,
				element.id,
				24 / Math.max(0.1, this.scene.appState.zoom)
			);
			const endPoint = this.getElementEndPoint(element);
			const endMatch = findNearestBindingTarget(
				endPoint,
				this.scene.elements,
				element.id,
				24 / Math.max(0.1, this.scene.appState.zoom)
			);
			element.startBinding = startMatch?.binding ?? null;
			element.endBinding = endMatch?.binding ?? null;
			if (element.type === "arrow") {
				element.startArrowhead = this.scene.appState.currentStyle.startArrowhead;
				element.endArrowhead = this.scene.appState.currentStyle.endArrowhead;
			}
			updateBoundElements(this.scene.elements);
			normalizeElementBounds(element);
		} else {
			finalizeElementSize(element, interaction.startWorld, interaction.didMove);
		}

		element.updated = Date.now();
		this.updateFrameMembership();
		this.commitHistory();
	}

	private getElementEndPoint(element: SceneElement): ScenePoint {
		const last = element.points?.[element.points.length - 1];
		return last
			? { x: element.x + last.x, y: element.y + last.y }
			: { x: element.x + element.width, y: element.y + element.height };
	}

	private updateBindingPreview(point: ScenePoint): void {
		if (this.activeTool !== "arrow" && this.activeTool !== "line") {
			if (this.bindingHighlightElement) {
				this.bindingHighlightElement = null;
				this.renderFrame();
			}
			return;
		}
		const match = findNearestBindingTarget(
			point,
			this.scene.elements,
			undefined,
			24 / Math.max(0.1, this.scene.appState.zoom)
		);
		const next = match?.element ?? null;
		if (next !== this.bindingHighlightElement) {
			this.bindingHighlightElement = next;
			this.renderFrame();
		}
	}

	private updateMove(
		interaction: Extract<PointerInteraction, { kind: "move" }>,
		world: ScenePoint
	): void {
		const dx = world.x - interaction.startWorld.x;
		const dy = world.y - interaction.startWorld.y;
		if (!interaction.started) {
			if (!interaction.didMove) return;
			this.history.beginTransaction(this.scene.elements, this.selectedIds);
			if (interaction.duplicateOnMove) {
				this.duplicateForDrag(interaction);
			}
			interaction.started = true;
			interaction.startElements = cloneElementMap(
				this.scene.elements,
				interaction.movingIds
			);
		}

		const startBounds = getSelectionAABB(
			Array.from(interaction.startElements.values())
		);
		let moveX = dx;
		let moveY = dy;
		this.snapGuides = [];
		if (startBounds) {
			const movingBounds = {
				...startBounds,
				minX: startBounds.minX + dx,
				maxX: startBounds.maxX + dx,
				cx: startBounds.cx + dx,
				minY: startBounds.minY + dy,
				maxY: startBounds.maxY + dy,
				cy: startBounds.cy + dy,
			};
			const snap = computeSnapOffset(
				movingBounds,
				this.scene.elements,
				interaction.movingIds,
				{
					snapToGrid: this.scene.appState.snapToGrid,
					gridSize: this.scene.appState.gridSize,
					snapToObjects: this.scene.appState.snapToObjects,
					zoom: this.scene.appState.zoom,
				}
			);
			moveX += snap.dx;
			moveY += snap.dy;
			this.snapGuides = snap.guides;
		}

		for (const [id, snapshot] of interaction.startElements.entries()) {
			const element = this.getElementById(id);
			if (!element || element.locked) continue;
			element.x = snapshot.x + moveX;
			element.y = snapshot.y + moveY;
			element.updated = Date.now();
			if (snapshot.points) {
				element.points = snapshot.points.map((point) => ({ ...point }));
			}
		}
		updateBoundElements(this.scene.elements);
		this.updateFrameMembership();
		this.renderFrame();
	}

	private duplicateForDrag(
		interaction: Extract<PointerInteraction, { kind: "move" }>
	): void {
		const source = Array.from(interaction.startElements.values());
		const idMap = new Map<string, string>();
		const groupMap = new Map<string, string>();
		for (const element of source) idMap.set(element.id, generateElementId(element.type));
		for (const element of source) {
			for (const groupId of element.groupIds ?? []) {
				if (!groupMap.has(groupId)) groupMap.set(groupId, generateElementId("group"));
			}
		}
		let nextZIndex = this.getNextZIndex();
		const copies = source.map((original): SceneElement => {
			const copy = cloneSceneElement(original);
			copy.id = idMap.get(original.id) ?? generateElementId(original.type);
			copy.groupIds = copy.groupIds.map((id) => groupMap.get(id) ?? id);
			copy.containerId = copy.containerId
				? idMap.get(copy.containerId) ?? null
				: null;
			copy.boundTextId = copy.boundTextId
				? idMap.get(copy.boundTextId) ?? null
				: null;
			copy.frameId = copy.frameId ? idMap.get(copy.frameId) ?? null : null;
			if (copy.startBinding) {
				copy.startBinding.elementId =
					idMap.get(copy.startBinding.elementId) ?? copy.startBinding.elementId;
			}
			if (copy.endBinding) {
				copy.endBinding.elementId =
					idMap.get(copy.endBinding.elementId) ?? copy.endBinding.elementId;
			}
			copy.zIndex = nextZIndex++;
			copy.updated = Date.now();
			return copy;
		});
		this.scene.elements.push(...copies);
		interaction.movingIds = new Set(copies.map((element) => element.id));
		this.selectedIds = new Set(interaction.movingIds);
		updateBoundElements(this.scene.elements);
	}

	private updateResize(
		interaction: Extract<PointerInteraction, { kind: "resize" }>,
		world: ScenePoint,
		keepRatio: boolean
	): void {
		const handle = interaction.handle;
		if (!isResizeHandle(handle.kind)) return;
		const kind = handle.kind;
		const pointer: ScenePoint = {
			x: world.x + (handle.x - interaction.startWorld.x),
			y: world.y + (handle.y - interaction.startWorld.y),
		};
		const frameElements = getSelectionFrameElements(
			Array.from(interaction.startElements.values())
		);
		const single = frameElements.length === 1 ? frameElements[0] : undefined;

		if (single && single.type === "text" && !single.containerId) {
			const element = this.getElementById(single.id);
			const ctx = this.getMeasureCtx();
			if (element && ctx && !element.locked) {
				this.applyTextGeometry(
					element,
					resizeTextFromHandle(ctx, single, kind, pointer)
				);
			}
		} else if (single && !single.points) {
			const element = this.getElementById(single.id);
			if (element && !element.locked) {
				const isImage = single.type === "image";
				const next = resizeBoxFromHandle(
					{
						x: single.x,
						y: single.y,
						width: single.width,
						height: single.height,
					},
					single.angle || 0,
					kind,
					pointer,
					{
						keepRatio: keepRatio || isImage,
						ratio: isImage
							? single.aspectRatio || single.width / Math.max(1, single.height)
							: undefined,
					}
				);
				element.x = next.x;
				element.y = next.y;
				element.width = next.width;
				element.height = next.height;
				element.updated = Date.now();
			}
		} else {
			const start = interaction.startBounds;
			const next = resizeBoxFromHandle(
				{
					x: start.minX,
					y: start.minY,
					width: start.width,
					height: start.height,
				},
				0,
				kind,
				pointer,
				{ keepRatio }
			);
			const anchorX = kind.includes("w")
				? start.maxX
				: kind.includes("e")
					? start.minX
					: start.cx;
			const anchorY = kind.includes("n")
				? start.maxY
				: kind.includes("s")
					? start.minY
					: start.cy;
			this.transformSelectionScale(
				interaction.startElements,
				anchorX,
				anchorY,
				next.width / Math.max(1, start.width),
				next.height / Math.max(1, start.height)
			);
		}
		updateBoundElements(this.scene.elements);
		this.updateFrameMembership();
		this.renderFrame();
	}

	private transformSelectionScale(
		startElements: Map<string, SceneElement>,
		anchorX: number,
		anchorY: number,
		scaleX: number,
		scaleY: number
	): void {
		for (const [id, snapshot] of startElements.entries()) {
			const element = this.getElementById(id);
			if (!element || element.locked) continue;
			if (
				(element.type === "arrow" ||
					element.type === "line" ||
					element.type === "freedraw") &&
				snapshot.points
			) {
				const points = snapshot.points.map((point) => ({
					x: anchorX + (snapshot.x + point.x - anchorX) * scaleX,
					y: anchorY + (snapshot.y + point.y - anchorY) * scaleY,
					pressure: point.pressure,
				}));
				this.setPathWorldPoints(element, points);
			} else if (element.type === "text" && !element.containerId) {
				const ctx = this.getMeasureCtx();
				if (ctx) {
					this.applyTextGeometry(
						element,
						scaleTextWithGroup(ctx, snapshot, scaleX, scaleY, anchorX, anchorY)
					);
				}
			} else {
				const x1 = anchorX + (snapshot.x - anchorX) * scaleX;
				const y1 = anchorY + (snapshot.y - anchorY) * scaleY;
				const x2 = anchorX + (snapshot.x + snapshot.width - anchorX) * scaleX;
				const y2 = anchorY + (snapshot.y + snapshot.height - anchorY) * scaleY;
				element.x = Math.min(x1, x2);
				element.y = Math.min(y1, y2);
				element.width = Math.max(4, Math.abs(x2 - x1));
				element.height = Math.max(4, Math.abs(y2 - y1));
				element.updated = Date.now();
			}
		}
	}

	private updateRotation(
		interaction: Extract<PointerInteraction, { kind: "rotate" }>,
		world: ScenePoint,
		snapAngle: boolean
	): void {
		let delta =
			Math.atan2(world.y - interaction.center.y, world.x - interaction.center.x) -
			interaction.startAngle;
		if (snapAngle) {
			const step = Math.PI / 12;
			const frameElements = getSelectionFrameElements(
				Array.from(interaction.startElements.values())
			);
			const only = frameElements.length === 1 ? frameElements[0] : undefined;
			const base = only && !only.points ? only.angle || 0 : 0;
			delta = Math.round((base + delta) / step) * step - base;
		}
		const cos = Math.cos(delta);
		const sin = Math.sin(delta);
		for (const [id, snapshot] of interaction.startElements.entries()) {
			const element = this.getElementById(id);
			if (!element || element.locked) continue;
			if (
				(element.type === "arrow" ||
					element.type === "line" ||
					element.type === "freedraw") &&
				snapshot.points
			) {
				const points = snapshot.points.map((point) => {
					const x = snapshot.x + point.x - interaction.center.x;
					const y = snapshot.y + point.y - interaction.center.y;
					return {
						x: interaction.center.x + x * cos - y * sin,
						y: interaction.center.y + x * sin + y * cos,
						pressure: point.pressure,
					};
				});
				this.setPathWorldPoints(element, points);
			} else {
				const cx = snapshot.x + snapshot.width / 2;
				const cy = snapshot.y + snapshot.height / 2;
				const dx = cx - interaction.center.x;
				const dy = cy - interaction.center.y;
				const nextCx = interaction.center.x + dx * cos - dy * sin;
				const nextCy = interaction.center.y + dx * sin + dy * cos;
				element.x = nextCx - snapshot.width / 2;
				element.y = nextCy - snapshot.height / 2;
				element.width = snapshot.width;
				element.height = snapshot.height;
				element.angle = snapshot.angle + delta;
				element.updated = Date.now();
			}
		}
		updateBoundElements(this.scene.elements);
		this.updateFrameMembership();
		this.renderFrame();
	}

	private movePathPoint(
		element: SceneElement,
		pointIndex: number,
		world: ScenePoint
	): void {
		if (!element.points || !element.points[pointIndex]) return;
		if (pointIndex === 0 && element.startBinding) element.startBinding = null;
		if (pointIndex === element.points.length - 1 && element.endBinding) {
			element.endBinding = null;
		}
		element.points[pointIndex] = {
			x: world.x - element.x,
			y: world.y - element.y,
			pressure: element.points[pointIndex]?.pressure,
		};
		this.updatePathBounds(element);
		element.updated = Date.now();
		updateBoundElements(this.scene.elements);
	}

	private bindEditedEndpoint(
		interaction: Extract<PointerInteraction, { kind: "point" }>
	): void {
		const element = this.getElementById(interaction.elementId);
		if (!element || (element.type !== "arrow" && element.type !== "line")) {
			return;
		}
		const lastIndex = (element.points?.length ?? 0) - 1;
		const maxDistance = 24 / Math.max(0.1, this.scene.appState.zoom);
		const firstPoint = element.points?.[0];
		if (interaction.pointIndex === 0 && firstPoint) {
			const match = findNearestBindingTarget(
				{ x: element.x + firstPoint.x, y: element.y + firstPoint.y },
				this.scene.elements,
				element.id,
				maxDistance
			);
			element.startBinding = match?.binding ?? null;
		} else if (interaction.pointIndex === lastIndex) {
			const match = findNearestBindingTarget(
				this.getElementEndPoint(element),
				this.scene.elements,
				element.id,
				maxDistance
			);
			element.endBinding = match?.binding ?? null;
		}
		updateBoundElements(this.scene.elements);
	}

	private updatePathBounds(element: SceneElement): void {
		normalizeElementBounds(element);
	}

	private setPathWorldPoints(
		element: SceneElement,
		worldPoints: ScenePoint[]
	): void {
		if (worldPoints.length === 0) return;
		element.points = worldPoints.map((point) => ({
			x: point.x - element.x,
			y: point.y - element.y,
			pressure: point.pressure,
		}));
		normalizeElementBounds(element);
	}

	private finishMarquee(
		interaction: Extract<PointerInteraction, { kind: "marquee" }>
	): void {
		const box = this.marqueeBox;
		if (!box) return;
		const matched = this.scene.elements.filter((element) => {
			if (element.isDeleted || element.containerId) return false;
			const bounds = getElementAABB(element);
			return (
				bounds.minX >= box.minX &&
				bounds.maxX <= box.maxX &&
				bounds.minY >= box.minY &&
				bounds.maxY <= box.maxY
			);
		});
		this.selectedIds = interaction.additive
			? new Set(interaction.selectionBefore)
			: new Set<string>();
		for (const element of matched) {
			this.addGroupedSelection(element.id);
		}
	}

	private eraseAt(point: ScenePoint): boolean {
		const hit = getElementAtPoint(
			this.scene.elements,
			point,
			this.scene.appState.zoom,
			false
		);
		if (!hit || hit.locked) return false;
		if (!this.history.hasPendingTransaction()) {
			this.history.beginTransaction(this.scene.elements, this.selectedIds);
		}
		this.markElementsDeleted([hit.id]);
		updateBoundElements(this.scene.elements);
		this.updatePropertiesPanel();
		return true;
	}

	private finishInteraction(): void {
		const current = this.interaction;
		if (
			current &&
			current.kind !== "pan" &&
			current.kind !== "marquee" &&
			(current.kind !== "move" || current.started) &&
			this.history.hasPendingTransaction()
		) {
			if (current.kind === "create") this.finalizeCreatedElement(current);
			this.commitHistory();
		} else if (this.history.hasPendingTransaction()) {
			this.history.cancelTransaction();
		}
		this.interaction = null;
		this.marqueeBox = null;
		this.snapGuides = [];
		this.eraserTrail = [];
		this.renderFrame();
	}

	private panByScreenDelta(dx: number, dy: number): void {
		const zoom = Math.max(0.1, this.scene.appState.zoom);
		this.scene.appState.scrollX += dx / zoom;
		this.scene.appState.scrollY += dy / zoom;
		this.notifySceneAndCameraChanged();
		this.positionTextEditor();
		this.renderFrame();
	}

	private zoomAt(screenPoint: CanvasPoint, factor: number): void {
		const prevZoom = this.scene.appState.zoom;
		const worldBefore = canvasPointToWorld(screenPoint, this.scene.appState);
		const nextZoom = clamp(prevZoom * factor, 0.1, 30);
		this.scene.appState.zoom = nextZoom;
		this.scene.appState.scrollX = screenPoint.x / nextZoom - worldBefore.x;
		this.scene.appState.scrollY = screenPoint.y / nextZoom - worldBefore.y;
		this.notifySceneAndCameraChanged();
		this.positionTextEditor();
		this.renderFrame();
	}

	private zoomByCenter(factor: number): void {
		const rect = this.canvasEl.getBoundingClientRect();
		this.zoomAt({ x: rect.width / 2, y: rect.height / 2 }, factor);
	}

	private updatePinch(): void {
		const points = Array.from(this.activePointers.values()).slice(-2);
		if (points.length < 2 || !this.pinchState) return;
		const dist = Math.max(1, getDistance(points[0]!, points[1]!));
		const center = getMidpoint(points[0]!, points[1]!);
		const nextZoom = clamp(
			this.pinchState.zoom * (dist / this.pinchState.distance),
			0.1,
			30
		);
		this.scene.appState.zoom = nextZoom;
		this.scene.appState.scrollX =
			center.x / nextZoom - this.pinchState.anchorWorld.x;
		this.scene.appState.scrollY =
			center.y / nextZoom - this.pinchState.anchorWorld.y;
		this.notifySceneAndCameraChanged();
		this.positionTextEditor();
		this.renderFrame();
	}

	private fitToAll(): void {
		this.fitElements(
			this.scene.elements.filter((element) => !element.isDeleted)
		);
	}

	private fitToSelection(): void {
		const selected = this.getSelectedElements();
		this.fitElements(selected.length > 0 ? selected : this.scene.elements);
	}

	private fitElements(elements: readonly SceneElement[]): void {
		const bounds = getSelectionAABB(
			elements.filter((element) => !element.isDeleted)
		);
		const rect = this.canvasEl.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			this.win.requestAnimationFrame(() => this.fitElements(elements));
			return;
		}
		if (!bounds) {
			this.scene.appState.zoom = 1;
			this.scene.appState.scrollX = 0;
			this.scene.appState.scrollY = 0;
			this.notifySceneAndCameraChanged();
			this.renderFrame();
			return;
		}
		const padding = 80;
		const zoom = clamp(
			Math.min(
				(rect.width - padding) / Math.max(1, bounds.width),
				(rect.height - padding) / Math.max(1, bounds.height)
			),
			0.1,
			30
		);
		this.scene.appState.zoom = zoom;
		this.scene.appState.scrollX = rect.width / (2 * zoom) - bounds.cx;
		this.scene.appState.scrollY = rect.height / (2 * zoom) - bounds.cy;
		this.notifySceneAndCameraChanged();
		this.renderFrame();
	}

	public getViewportCenterWorld(): ScenePoint {
		const rect = this.canvasEl.getBoundingClientRect();
		return canvasPointToWorld(
			{ x: rect.width / 2, y: rect.height / 2 },
			this.scene.appState
		);
	}

	private getDropWorldPoint(event: DragEvent): ScenePoint {
		const rect = this.canvasEl.getBoundingClientRect();
		return canvasPointToWorld(
			{ x: event.clientX - rect.left, y: event.clientY - rect.top },
			this.scene.appState
		);
	}

	private updateZoomLabel(): void {
		if (!this.zoomLabelEl) return;
		const percent = Math.round(this.scene.appState.zoom * 100);
		this.zoomLabelEl.textContent = `${percent}%`;
		this.zoomLabelEl.title = `Масштаб ${percent}% — нажми, чтобы вписать всё`;
	}

	private selectOnly(id: string): void {
		this.selectedIds = new Set([id]);
		this.updatePropertiesPanel();
		this.renderFrame();
	}

	private selectOnlyGroup(id: string): void {
		this.selectedIds.clear();
		this.addGroupedSelection(id);
	}

	private addGroupedSelection(id: string): void {
		const queue = [id];
		while (queue.length > 0) {
			const current = queue.pop();
			if (!current || this.selectedIds.has(current)) continue;
			const element = this.getElementById(current);
			if (!element || element.isDeleted) continue;
			this.selectedIds.add(current);
			for (const groupId of element.groupIds ?? []) {
				for (const candidate of this.scene.elements) {
					if (
						!candidate.isDeleted &&
						candidate.groupIds?.includes(groupId) &&
						!this.selectedIds.has(candidate.id)
					) {
						queue.push(candidate.id);
					}
				}
			}
			if (element.containerId) queue.push(element.containerId);
			if (element.boundTextId) queue.push(element.boundTextId);
		}
	}

	private selectAll(): void {
		this.selectedIds = new Set(
			this.scene.elements
				.filter((element) => !element.isDeleted && !element.containerId)
				.map((element) => element.id)
		);
		for (const element of this.scene.elements) {
			if (element.boundTextId && this.selectedIds.has(element.id)) {
				this.selectedIds.add(element.boundTextId);
			}
		}
		this.updatePropertiesPanel();
		this.renderFrame();
	}

	private moveSelectionBy(dx: number, dy: number): void {
		const movable = this.getSelectedElements().filter((element) => !element.locked);
		if (movable.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		for (const element of movable) {
			element.x += dx;
			element.y += dy;
			element.updated = Date.now();
		}
		updateBoundElements(this.scene.elements);
		this.updateFrameMembership();
		this.commitHistory();
	}

	private groupSelection(): void {
		const selected = this.getSelectedElements();
		if (selected.length < 2) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const groupId = generateElementId("group");
		for (const element of selected) {
			element.groupIds = [...(element.groupIds ?? []), groupId];
			element.updated = Date.now();
		}
		this.commitHistory();
	}

	private ungroupSelection(): void {
		const selected = this.getSelectedElements();
		if (selected.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		for (const element of selected) {
			element.groupIds = (element.groupIds ?? []).slice(0, -1);
			element.updated = Date.now();
		}
		this.commitHistory();
	}

	private deleteSelection(): void {
		const deletable = this.getSelectedElements().filter(
			(element) => !element.locked
		);
		if (deletable.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		this.markElementsDeleted(deletable.map((element) => element.id));
		this.selectedIds.clear();
		updateBoundElements(this.scene.elements);
		this.commitHistory();
	}

	private markElementsDeleted(ids: readonly string[]): void {
		const visited = new Set<string>();
		const queue = [...ids];
		while (queue.length > 0) {
			const id = queue.pop();
			if (!id || visited.has(id)) continue;
			visited.add(id);
			const element = this.getElementById(id);
			if (element?.boundTextId) queue.push(element.boundTextId);
			for (const candidate of this.scene.elements) {
				if (!candidate.isDeleted && candidate.containerId === id) {
					queue.push(candidate.id);
				}
			}
		}
		for (const id of visited) {
			const element = this.getElementById(id);
			if (element && !element.isDeleted) {
				element.isDeleted = true;
				element.updated = Date.now();
				this.selectedIds.delete(id);
			}
		}
	}

	private duplicateSelection(): void {
		const selected = this.getSelectedElements();
		if (selected.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const selectedSet = new Set(selected.map((element) => element.id));
		const clones = this.cloneElements(selected, selectedSet, 24, 24);
		this.scene.elements.push(...clones);
		this.selectedIds = new Set(clones.map((element) => element.id));
		updateBoundElements(this.scene.elements);
		this.commitHistory();
	}

	private cloneElements(
		source: readonly SceneElement[],
		selectedSet: ReadonlySet<string>,
		dx: number,
		dy: number
	): SceneElement[] {
		const idMap = new Map<string, string>();
		const groupMap = new Map<string, string>();
		for (const element of source) idMap.set(element.id, generateElementId(element.type));
		for (const element of source) {
			for (const groupId of element.groupIds ?? []) {
				if (!groupMap.has(groupId)) groupMap.set(groupId, generateElementId("group"));
			}
		}
		return source.map((original): SceneElement => {
			const copy = cloneSceneElement(original);
			copy.id = idMap.get(original.id) ?? generateElementId(original.type);
			copy.x += dx;
			copy.y += dy;
			copy.zIndex = this.getNextZIndex() + source.indexOf(original);
			copy.updated = Date.now();
			copy.groupIds = copy.groupIds.map((id) => groupMap.get(id) ?? id);
			copy.containerId =
				copy.containerId && selectedSet.has(copy.containerId)
					? idMap.get(copy.containerId) ?? null
					: null;
			copy.boundTextId =
				copy.boundTextId && selectedSet.has(copy.boundTextId)
					? idMap.get(copy.boundTextId) ?? null
					: null;
			copy.frameId =
				copy.frameId && selectedSet.has(copy.frameId)
					? idMap.get(copy.frameId) ?? null
					: null;
			if (copy.startBinding) {
				copy.startBinding.elementId =
					idMap.get(copy.startBinding.elementId) ?? copy.startBinding.elementId;
			}
			if (copy.endBinding) {
				copy.endBinding.elementId =
					idMap.get(copy.endBinding.elementId) ?? copy.endBinding.elementId;
			}
			return copy;
		});
	}

	private changeLayerOrder(
		direction: "front" | "back" | "forward" | "backward"
	): void {
		const active = this.scene.elements
			.filter((element) => !element.isDeleted)
			.sort((a, b) => a.zIndex - b.zIndex);
		const selected = active.filter((element) => this.selectedIds.has(element.id));
		if (selected.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		let reordered: SceneElement[];
		if (direction === "front") {
			reordered = [
				...active.filter((element) => !this.selectedIds.has(element.id)),
				...selected,
			];
		} else if (direction === "back") {
			reordered = [
				...selected,
				...active.filter((element) => !this.selectedIds.has(element.id)),
			];
		} else {
			reordered = [...active];
			if (direction === "forward") {
				for (let i = reordered.length - 2; i >= 0; i--) {
					if (
						this.selectedIds.has(reordered[i]!.id) &&
						!this.selectedIds.has(reordered[i + 1]!.id)
					) {
						[reordered[i], reordered[i + 1]] = [
							reordered[i + 1]!,
							reordered[i]!,
						];
					}
				}
			} else {
				for (let i = 1; i < reordered.length; i++) {
					if (
						this.selectedIds.has(reordered[i]!.id) &&
						!this.selectedIds.has(reordered[i - 1]!.id)
					) {
						[reordered[i], reordered[i - 1]] = [
							reordered[i - 1]!,
							reordered[i]!,
						];
					}
				}
			}
		}
		reordered.forEach((element, index) => {
			element.zIndex = index;
			element.updated = Date.now();
		});
		this.scene.elements = [
			...reordered,
			...this.scene.elements.filter((element) => element.isDeleted),
		];
		this.commitHistory();
	}

	private alignSelection(
		mode: "left" | "center-x" | "right" | "top" | "center-y" | "bottom"
	): void {
		const movable = this.getSelectedElements().filter((element) => !element.locked);
		if (movable.length < 2) return;
		const bounds = getSelectionAABB(movable);
		if (!bounds) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		for (const element of movable) {
			const box = getElementAABB(element);
			let dx = 0;
			let dy = 0;
			if (mode === "left") dx = bounds.minX - box.minX;
			else if (mode === "center-x") dx = bounds.cx - box.cx;
			else if (mode === "right") dx = bounds.maxX - box.maxX;
			else if (mode === "top") dy = bounds.minY - box.minY;
			else if (mode === "center-y") dy = bounds.cy - box.cy;
			else dy = bounds.maxY - box.maxY;
			element.x += dx;
			element.y += dy;
			element.updated = Date.now();
		}
		updateBoundElements(this.scene.elements);
		this.commitHistory();
	}

	private distributeSelection(axis: "horizontal" | "vertical"): void {
		const movable = this.getSelectedElements().filter((element) => !element.locked);
		if (movable.length < 3) return;
		const sorted = [...movable].sort((a, b) => {
			const boxA = getElementAABB(a);
			const boxB = getElementAABB(b);
			return axis === "horizontal" ? boxA.cx - boxB.cx : boxA.cy - boxB.cy;
		});
		const firstBox = getElementAABB(sorted[0]!);
		const lastBox = getElementAABB(sorted[sorted.length - 1]!);
		const span =
			axis === "horizontal"
				? lastBox.maxX - firstBox.minX
				: lastBox.maxY - firstBox.minY;
		const occupied = sorted.reduce((sum, item) => {
			const box = getElementAABB(item);
			return sum + (axis === "horizontal" ? box.width : box.height);
		}, 0);
		const gap = (span - occupied) / (sorted.length - 1);
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		let cursor = axis === "horizontal" ? firstBox.minX : firstBox.minY;
		for (const item of sorted) {
			const box = getElementAABB(item);
			const size = axis === "horizontal" ? box.width : box.height;
			const delta = cursor - (axis === "horizontal" ? box.minX : box.minY);
			if (axis === "horizontal") item.x += delta;
			else item.y += delta;
			item.updated = Date.now();
			cursor += size + gap;
		}
		updateBoundElements(this.scene.elements);
		this.commitHistory();
	}

	private updateFrameMembership(): void {
		const frames = this.scene.elements.filter(
			(element) => !element.isDeleted && element.type === "frame"
		);
		for (const element of this.scene.elements) {
			if (element.isDeleted || element.type === "frame") continue;
			const box = getElementAABB(element);
			const matching = frames
				.filter((frame) => {
					const frameBox = getElementAABB(frame);
					return (
						box.cx >= frameBox.minX &&
						box.cx <= frameBox.maxX &&
						box.cy >= frameBox.minY &&
						box.cy <= frameBox.maxY
					);
				})
				.sort(
					(a, b) =>
						getElementAABB(a).width * getElementAABB(a).height -
						getElementAABB(b).width * getElementAABB(b).height
				);
			element.frameId = matching[0]?.id ?? null;
		}
	}

	private makeAABB(x1: number, y1: number, x2: number, y2: number): AABB {
		const minX = Math.min(x1, x2);
		const minY = Math.min(y1, y2);
		const maxX = Math.max(x1, x2);
		const maxY = Math.max(y1, y2);
		const width = maxX - minX;
		const height = maxY - minY;
		return {
			minX,
			minY,
			maxX,
			maxY,
			width,
			height,
			cx: minX + width / 2,
			cy: minY + height / 2,
		};
	}

	private commitHistory(refreshPanel = true): void {
		const committed = this.history.commitTransaction(
			this.scene.elements,
			this.selectedIds
		);
		this.updateHistoryButtons();
		if (committed) {
			this.notifySceneAndCameraChanged();
			if (refreshPanel) this.updatePropertiesPanel();
		}
		this.renderFrame();
	}

	private undo(): void {
		const restored = this.history.undo(this.scene.elements);
		if (!restored) return;
		this.scene.elements = restored.elements;
		this.selectedIds = restored.selection;
		updateBoundElements(this.scene.elements);
		this.updateFrameMembership();
		this.notifySceneAndCameraChanged();
		this.updateHistoryButtons();
		this.updatePropertiesPanel();
		this.renderFrame();
	}

	private redo(): void {
		const restored = this.history.redo(this.scene.elements);
		if (!restored) return;
		this.scene.elements = restored.elements;
		this.selectedIds = restored.selection;
		updateBoundElements(this.scene.elements);
		this.updateFrameMembership();
		this.notifySceneAndCameraChanged();
		this.updateHistoryButtons();
		this.updatePropertiesPanel();
		this.renderFrame();
	}

	private updateHistoryButtons(): void {
		if (!this.undoBtn || !this.redoBtn) return;
		this.undoBtn.disabled = !this.history.canUndo();
		this.redoBtn.disabled = !this.history.canRedo();
	}

	private notifySceneAndCameraChanged(): void {
		if (this.destroyed) return;
		this.callbacks.onSceneChange(this.scene);
		this.callbacks.onCameraChange?.(this.getCameraState());
	}

	private reportAsyncError(error: unknown): void {
		new Notice(
			"Ошибка обработки изображения: " +
				(error instanceof Error ? error.message : String(error))
		);
	}

	private toggleActionMenu(): void {
		this.menuPanelEl.classList.toggle("is-hidden");
	}

	private hideActionMenu(): void {
		this.menuPanelEl.classList.add("is-hidden");
	}

	private updatePropertiesPanel(): void {
		if (!this.propertiesEl) return;
		this.propertiesEl.replaceChildren();
const selected = this.getSelectedElements();
		const primarySelected = selected.filter((el) => !el.containerId);
		const displayList = primarySelected.length > 0 ? primarySelected : selected;
		const hasSelection = displayList.length > 0;
		const showPanel = hasSelection && this.propertiesOpen;

		if (this.propsToggleBtn) {
			this.propsToggleBtn.disabled = !hasSelection;
			this.propsToggleBtn.classList.toggle("is-active", showPanel);
		}

		if (!hasSelection) {
			this.propertiesEl.classList.add("is-hidden");
			this.updateSelectionFloatingBar();
			return;
		}
		this.propertiesEl.classList.toggle("is-hidden", !showPanel);

		const primary = displayList[0]!;
		const textSample =
			selected.find((el) => el.type === "text" || el.text !== undefined) ??
			primary;

		const hasStroke = displayList.some((el) => el.type !== "image");
		const hasFill = displayList.some(
			(el) =>
				el.type === "rectangle" ||
				el.type === "diamond" ||
				el.type === "ellipse" ||
				el.type === "note"
		);
		const hasStrokeStyle = displayList.some(
			(el) =>
				el.type === "rectangle" ||
				el.type === "diamond" ||
				el.type === "ellipse" ||
				el.type === "arrow" ||
				el.type === "line" ||
				el.type === "note"
		);
		const hasStrokeWidth = displayList.some(
			(el) => el.type !== "text" && el.type !== "image" && el.type !== "frame"
		);
		const hasRoughness = displayList.some(
			(el) =>
				el.type === "rectangle" ||
				el.type === "diamond" ||
				el.type === "ellipse" ||
				el.type === "arrow" ||
				el.type === "line"
		);
		const hasRoundness = displayList.some(
			(el) => el.type === "rectangle" || el.type === "image"
		);
		const hasPathRouting = displayList.some(
			(el) => el.type === "arrow" || el.type === "line"
		);
		const hasArrowheads = displayList.some((el) => el.type === "arrow");
		const hasTypography = selected.some(
			(el) =>
				el.type === "text" ||
				el.type === "note" ||
				el.type === "rectangle" ||
				el.type === "diamond" ||
				el.type === "ellipse"
		);

		const header = this.doc.createElement("div");
		header.className = "my-sc-canvas-prop-header";
		const title = this.doc.createElement("h4");
		title.textContent =
			displayList.length === 1
				? this.getElementTypeTitle(primary.type)
				: `Выбрано: ${displayList.length}`;
		header.appendChild(title);
		this.createButton(
			header,
			"x",
			"Скрыть свойства",
			() => this.togglePropertiesPanelVisibility(false),
			"my-sc-canvas-prop-close-btn"
		);

		const quickActions = this.doc.createElement("div");
		quickActions.className = "my-sc-canvas-property-actions";
		this.createButton(
			quickActions,
			"copy",
			"Дублировать (Ctrl+D)",
			() => this.duplicateSelection(),
			"my-sc-canvas-prop-icon-btn"
		);
		this.createButton(
			quickActions,
			"layers",
			"На задний план",
			() => this.changeLayerOrder("back"),
			"my-sc-canvas-prop-icon-btn"
		);
		this.createButton(
			quickActions,
			"layers-2",
			"На передний план",
			() => this.changeLayerOrder("front"),
			"my-sc-canvas-prop-icon-btn"
		);
		const isLocked = displayList.every((el) => el.locked);
		const lockBtn = this.createButton(
			quickActions,
			isLocked ? "lock" : "unlock",
			isLocked ? "Разблокировать" : "Закрепить",
			() => this.toggleSelectedLock(),
			"my-sc-canvas-prop-icon-btn"
		);
		lockBtn.classList.toggle("is-active", isLocked);
		const deleteBtn = this.createButton(
			quickActions,
			"trash-2",
			"Удалить (Del)",
			() => this.deleteSelection(),
			"my-sc-canvas-prop-icon-btn is-danger"
		);
		deleteBtn.disabled = isLocked;
		this.propertiesEl.append(header, quickActions);

		if (hasStroke) {
			const strokeTitle =
				displayList.every((el) => el.type === "text") ? "Цвет текста" : "Обводка";
			this.addStrokePaletteSection(strokeTitle, primary.strokeColor, (color) => {
				this.updateSelected(
					(el) => {
						if (el.containerId && displayList.some((item) => item.id === el.containerId)) {
							return;
						}
						el.strokeColor = color;
					},
					(style) => {
						style.strokeColor = color;
					},
					true
				);
			});
		}

		if (hasFill) {
			this.addBackgroundPaletteSection(
				"Фон",
				primary.fillStyle === "none" ? "transparent" : primary.backgroundColor,
				(color) => {
					this.updateSelected(
						(el) => {
							if (el.containerId) return;
							el.backgroundColor = color;
							if (color === "transparent") {
								el.fillStyle = "none";
							} else if (el.fillStyle === "none") {
								el.fillStyle = "solid";
							}
						},
						(style) => {
							style.backgroundColor = color;
							if (color === "transparent") {
								style.fillStyle = "none";
							} else if (style.fillStyle === "none") {
								style.fillStyle = "solid";
							}
						},
						true
					);
				}
			);

			this.addSegmentedSection<SceneElement["fillStyle"]>(
				"Заливка",
				primary.fillStyle,
				[
					{
						value: "solid",
						title: "Сплошная заливка",
						renderSvg: (svg, doc) => {
							const rect = doc.createElementNS(SVG_NS, "rect");
							rect.setAttribute("x", "3");
							rect.setAttribute("y", "3");
							rect.setAttribute("width", "14");
							rect.setAttribute("height", "14");
							rect.setAttribute("rx", "3");
							rect.setAttribute("fill", "currentColor");
							svg.appendChild(rect);
						},
					},
					{
						value: "hachure",
						title: "Штриховка",
						renderSvg: (svg, doc) => {
							this.appendSvgPath(
								svg,
								doc,
								"M4 4h12v12H4z M5 14L14 5 M8 16l8-8 M4 10l6-6"
							);
						},
					},
					{
						value: "cross-hatch",
						title: "Перекрёстная штриховка",
						renderSvg: (svg, doc) => {
							this.appendSvgPath(
								svg,
								doc,
								"M4 4h12v12H4z M5 15L15 5 M5 5l10 10"
							);
						},
					},
					{
						value: "none",
						title: "Без заливки",
						renderSvg: (svg, doc) => {
							this.appendSvgPath(svg, doc, "M4 4h12v12H4z M5 15L15 5");
						},
					},
				],
				(fillStyle) => {
					this.updateSelected(
						(el) => {
							if (el.containerId) return;
							el.fillStyle = fillStyle;
							if (
								fillStyle !== "none" &&
								(!el.backgroundColor || el.backgroundColor === "transparent")
							) {
								el.backgroundColor = DEFAULT_ELEMENT_STYLE.backgroundColor;
							}
						},
						(style) => {
							style.fillStyle = fillStyle;
						},
						true
					);
				}
			);
		}

		if (hasStrokeWidth) {
			const activeWidth =
				primary.strokeWidth <= 1.5 ? 1 : primary.strokeWidth <= 3 ? 2 : 4;
			this.addSegmentedSection<number>(
				"Толщина",
				activeWidth,
				[
					{
						value: 1,
						title: "Тонкая (1 px)",
						renderSvg: (svg, doc) => this.appendStrokeWidthPreview(svg, doc, 1.5),
					},
					{
						value: 2,
						title: "Средняя (2 px)",
						renderSvg: (svg, doc) => this.appendStrokeWidthPreview(svg, doc, 3),
					},
					{
						value: 4,
						title: "Толстая (4 px)",
						renderSvg: (svg, doc) => this.appendStrokeWidthPreview(svg, doc, 5),
					},
				],
				(width) => {
					this.updateSelected(
						(el) => {
							if (!el.containerId) el.strokeWidth = width;
						},
						(style) => {
							style.strokeWidth = width;
						},
						true
					);
				}
			);
		}

		if (hasStrokeStyle) {
			this.addSegmentedSection<SceneElement["strokeStyle"]>(
				"Стиль линии",
				primary.strokeStyle,
				[
					{
						value: "solid",
						title: "Сплошная",
						renderSvg: (svg, doc) => this.appendLineDashPreview(svg, doc, ""),
					},
					{
						value: "dashed",
						title: "Штриховая",
						renderSvg: (svg, doc) => this.appendLineDashPreview(svg, doc, "4 3"),
					},
					{
						value: "dotted",
						title: "Точечная",
						renderSvg: (svg, doc) => this.appendLineDashPreview(svg, doc, "1.5 3"),
					},
				],
				(strokeStyle) => {
					this.updateSelected(
						(el) => {
							if (!el.containerId) el.strokeStyle = strokeStyle;
						},
						(style) => {
							style.strokeStyle = strokeStyle;
						},
						true
					);
				}
			);
		}

		if (hasRoughness) {
			const activeRoughness =
				primary.roughness <= 0.2 ? 0 : primary.roughness <= 1.3 ? 1 : 2;
			this.addSegmentedSection<number>(
				"Рисовка",
				activeRoughness,
				[
					{
						value: 0,
						title: "Чёткая геометрия",
						renderSvg: (svg, doc) =>
							this.appendSvgPath(svg, doc, "M3 14L17 6"),
					},
					{
						value: 1,
						title: "От руки",
						renderSvg: (svg, doc) =>
							this.appendSvgPath(svg, doc, "M3 13C7 8 13 12 17 7"),
					},
					{
						value: 2,
						title: "Эскиз",
						renderSvg: (svg, doc) =>
							this.appendSvgPath(
								svg,
								doc,
								"M3 12C7 6 13 14 17 6 M3 15C8 9 12 16 17 9"
							),
					},
				],
				(roughness) => {
					this.updateSelected(
						(el) => {
							if (!el.containerId) el.roughness = roughness;
						},
						(style) => {
							style.roughness = roughness;
						},
						true
					);
				}
			);
		}

		if (hasRoundness) {
			const activeRoundness =
				primary.roundness <= 2 ? 0 : primary.roundness <= 12 ? 8 : 20;
			this.addSegmentedSection<number>(
				"Углы",
				activeRoundness,
				[
					{
						value: 0,
						title: "Острые углы",
						renderSvg: (svg, doc) =>
							this.appendSvgPath(svg, doc, "M5 15V5h10"),
					},
					{
						value: 8,
						title: "Мягкое скругление",
						renderSvg: (svg, doc) =>
							this.appendSvgPath(svg, doc, "M5 15V9a4 4 0 0 1 4-4h6"),
					},
					{
						value: 20,
						title: "Сильное скругление",
						renderSvg: (svg, doc) =>
							this.appendSvgPath(svg, doc, "M5 15V13a8 8 0 0 1 8-8h2"),
					},
				],
				(roundness) => {
					this.updateSelected(
						(el) => {
							if (!el.containerId) el.roundness = roundness;
						},
						(style) => {
							style.roundness = roundness;
						},
						true
					);
				}
			);
		}

		if (hasPathRouting) {
			const routingMode: "straight" | "curved" | "elbowed" = primary.curved
				? "curved"
				: primary.elbowed
					? "elbowed"
					: "straight";
			this.addSegmentedSection<"straight" | "curved" | "elbowed">(
				"Траектория",
				routingMode,
				[
					{
						value: "straight",
						title: "Прямая линия",
						renderSvg: (svg, doc) =>
							this.appendSvgPath(svg, doc, "M4 15L16 5"),
					},
					{
						value: "curved",
						title: "Плавная дуга",
						renderSvg: (svg, doc) =>
							this.appendSvgPath(svg, doc, "M4 15C5 6 15 14 16 5"),
					},
					{
						value: "elbowed",
						title: "Ломаная под 90°",
						renderSvg: (svg, doc) =>
							this.appendSvgPath(svg, doc, "M4 15h6V5h6"),
					},
				],
				(mode) => {
					this.updateSelected(
						(el) => {
							el.curved = mode === "curved";
							el.elbowed = mode === "elbowed";
						},
						(style) => {
							style.curved = mode === "curved";
							style.elbowed = mode === "elbowed";
						},
						true
					);
				}
			);
		}

		if (hasArrowheads) {
			const headOptions = this.getArrowheadSegmentOptions();
			this.addSegmentedSection(
				"Начало стрелки",
				primary.startArrowhead ?? "none",
				headOptions,
				(head) => {
					this.updateSelected(
						(el) => {
							el.startArrowhead = head;
						},
						(style) => {
							style.startArrowhead = head;
						},
						true
					);
				}
			);
			this.addSegmentedSection(
				"Конец стрелки",
				primary.endArrowhead ?? "arrow",
				headOptions,
				(head) => {
					this.updateSelected(
						(el) => {
							el.endArrowhead = head;
						},
						(style) => {
							style.endArrowhead = head;
						},
						true
					);
				}
			);
		}

		if (hasTypography) {
			this.addSegmentedSection<SceneElement["fontFamily"]>(
				"Шрифт",
				textSample.fontFamily,
				[
					{ value: "normal", title: "Обычный шрифт", label: "Аа" },
					{ value: "hand", title: "Рукописный шрифт", label: "✍️" },
					{ value: "mono", title: "Моноширинный код", label: "{}" },
				],
				(fontFamily) => {
					this.updateSelected(
						(el) => {
							el.fontFamily = fontFamily;
						},
						(style) => {
							style.fontFamily = fontFamily;
						},
						true
					);
				}
			);

			const activeSize =
				textSample.fontSize <= 17
					? 16
					: textSample.fontSize <= 24
						? 20
						: textSample.fontSize <= 32
							? 28
							: 36;
			this.addSegmentedSection<number>(
				"Размер текста",
				activeSize,
				[
					{ value: 16, title: "Малый (16 px)", label: "S" },
					{ value: 20, title: "Средний (20 px)", label: "M" },
					{ value: 28, title: "Крупный (28 px)", label: "L" },
					{ value: 36, title: "Заголовок (36 px)", label: "XL" },
				],
				(fontSize) => {
					this.updateSelected(
						(el) => {
							el.fontSize = fontSize;
						},
						(style) => {
							style.fontSize = fontSize;
						},
						true
					);
				}
			);

			this.addSegmentedSection<SceneElement["textAlign"]>(
				"Выравнивание",
				textSample.textAlign,
				[
					{ value: "left", title: "По левому краю", obsidianIcon: "align-left" },
					{ value: "center", title: "По центру", obsidianIcon: "align-center" },
					{ value: "right", title: "По правому краю", obsidianIcon: "align-right" },
				],
				(textAlign) => {
					this.updateSelected(
						(el) => {
							el.textAlign = textAlign;
						},
						(style) => {
							style.textAlign = textAlign;
						},
						true
					);
				}
			);
		}

		this.addOpacitySliderSection(primary.opacity);

this.addLinkPropertySection(primary.link ?? "", (nextLink) => {
			this.updateSelected(
				(el) => {
					if (!el.containerId) el.link = nextLink.trim() || null;
				},
				() => {},
				false
			);
		});
		this.updateSelectionFloatingBar();
	}

private togglePenOnlyMode(force?: boolean): void {
		this.penOnlyMode = force !== undefined ? force : !this.penOnlyMode;
		this.penOnlyBtn?.classList.toggle("is-active", this.penOnlyMode);
		this.penOnlyBtn?.setAttribute("aria-pressed", String(this.penOnlyMode));
		this.updateMenuToggles();
		new Notice(
			this.penOnlyMode
				? "Режим стилуса включён: перо рисует, палец двигает холст."
				: "Режим стилуса выключен: касание пальцем работает как обычно."
		);
	}

	private togglePropertiesPanelVisibility(force?: boolean): void {
		if (!this.propertiesEl) return;
		if (this.getSelectedElements().length === 0) {
			new Notice("Сначала выдели объект на холсте.");
			return;
		}
		this.propertiesOpen =
			force !== undefined ? force : !this.propertiesOpen;
		this.propertiesEl.classList.toggle("is-hidden", !this.propertiesOpen);
		if (this.propsToggleBtn) {
			this.propsToggleBtn.classList.toggle("is-active", this.propertiesOpen);
		}
		this.updateSelectionFloatingBar();
	}

	private updateSelectionFloatingBar(): void {
		if (!this.selectionBarEl) return;
		const selected = this.getSelectedElements();
		if (
			selected.length === 0 ||
			this.editingElementId !== null ||
			this.interaction?.kind === "create" ||
			this.interaction?.kind === "move" ||
			this.interaction?.kind === "resize" ||
			this.interaction?.kind === "rotate" ||
			this.interaction?.kind === "marquee"
		) {
			this.selectionBarEl.classList.add("is-hidden");
			return;
		}

		const bounds = getSelectionAABB(getSelectionFrameElements(selected));
		if (!bounds) {
			this.selectionBarEl.classList.add("is-hidden");
			return;
		}

		const wrapRect = this.canvasWrapEl.getBoundingClientRect();
		if (wrapRect.width <= 0 || wrapRect.height <= 0) {
			this.selectionBarEl.classList.add("is-hidden");
			return;
		}

		this.selectionBarEl.replaceChildren();
		const isLocked = selected.every((el) => el.locked);
		const propsOpen =
			this.propertiesEl && !this.propertiesEl.classList.contains("is-hidden");

		const styleBtn = this.createButton(
			this.selectionBarEl,
			"palette",
			propsOpen ? "Скрыть панель свойств" : "Открыть свойства элемента",
			() => this.togglePropertiesPanelVisibility(),
			"my-sc-canvas-sel-btn"
		);
		styleBtn.classList.toggle("is-active", Boolean(propsOpen));

		this.createButton(
			this.selectionBarEl,
			"copy",
			"Дублировать (Ctrl+D)",
			() => this.duplicateSelection(),
			"my-sc-canvas-sel-btn"
		);
		this.createButton(
			this.selectionBarEl,
			"layers-2",
			"На передний план",
			() => this.changeLayerOrder("front"),
			"my-sc-canvas-sel-btn"
		);
		this.createButton(
			this.selectionBarEl,
			"layers",
			"На задний план",
			() => this.changeLayerOrder("back"),
			"my-sc-canvas-sel-btn"
		);

		const lockBtn = this.createButton(
			this.selectionBarEl,
			isLocked ? "lock" : "unlock",
			isLocked ? "Разблокировать" : "Закрепить",
			() => this.toggleSelectedLock(),
			"my-sc-canvas-sel-btn"
		);
		lockBtn.classList.toggle("is-active", isLocked);

		const delBtn = this.createButton(
			this.selectionBarEl,
			"trash-2",
			"Удалить (Del)",
			() => this.deleteSelection(),
			"my-sc-canvas-sel-btn is-danger"
		);
		delBtn.disabled = isLocked;

		this.selectionBarEl.classList.remove("is-hidden");

		const { scrollX, scrollY, zoom } = this.scene.appState;
		const safeZoom = Math.max(0.1, zoom);
		const screenCenterX = (bounds.cx + scrollX) * safeZoom;
		const screenTopY = (bounds.minY + scrollY) * safeZoom;
		const screenBottomY = (bounds.maxY + scrollY) * safeZoom;

		const barWidth = this.selectionBarEl.offsetWidth || 216;
		const barHeight = this.selectionBarEl.offsetHeight || 38;
		const clampedLeft = clamp(
			screenCenterX - barWidth / 2,
			10,
			Math.max(10, wrapRect.width - barWidth - 10)
		);

		let top = screenTopY - barHeight - 36;
		if (top < 58) {
			top = Math.min(wrapRect.height - barHeight - 58, screenBottomY + 18);
		}
		top = clamp(top, 54, Math.max(54, wrapRect.height - barHeight - 54));

		this.selectionBarEl.style.left = `${Math.round(clampedLeft)}px`;
		this.selectionBarEl.style.top = `${Math.round(top)}px`;
	}

	private getElementTypeTitle(type: SceneElement["type"]): string {
		switch (type) {
			case "rectangle":
				return "Прямоугольник";
			case "diamond":
				return "Ромб";
			case "ellipse":
				return "Эллипс";
			case "arrow":
				return "Стрелка";
			case "line":
				return "Линия";
			case "freedraw":
				return "Набросок";
			case "text":
				return "Текст";
			case "image":
				return "Изображение";
			case "note":
				return "Заметка";
			case "frame":
				return "Рамка";
		}
	}

	private createPropertySection(labelText: string): HTMLDivElement {
		const section = this.doc.createElement("div");
		section.className = "my-sc-canvas-prop-section";
		const label = this.doc.createElement("div");
		label.className = "my-sc-canvas-prop-label";
		label.textContent = labelText;
		section.appendChild(label);
		this.propertiesEl.appendChild(section);
		return section;
	}

	private addStrokePaletteSection(
		labelText: string,
		currentColor: string,
		onSelect: (color: string) => void
	): void {
		const section = this.createPropertySection(labelText);
		const grid = this.doc.createElement("div");
		grid.className = "my-sc-canvas-color-grid";
		const normalizedCurrent = currentColor.trim().toLowerCase();
		let matchedPreset = false;

		for (const item of STROKE_PALETTE) {
			const btn = this.doc.createElement("button");
			btn.type = "button";
			btn.className = "my-sc-canvas-color-swatch";
			btn.title = item.title;
			btn.setAttribute("aria-label", item.title);
			btn.style.setProperty("--swatch-color", item.color);
			const isMatch = item.color.toLowerCase() === normalizedCurrent;
			if (isMatch) matchedPreset = true;
			btn.classList.toggle("is-active", isMatch);
			btn.addEventListener("click", () => onSelect(item.color));
			grid.appendChild(btn);
		}

		const pickerWrap = this.doc.createElement("label");
		pickerWrap.className = "my-sc-canvas-color-swatch is-custom-picker";
		pickerWrap.title = "Свой цвет…";
		const hexValue = normalizeColorToHex(currentColor);
		pickerWrap.style.setProperty("--swatch-color", hexValue);
		pickerWrap.classList.toggle("is-active", !matchedPreset);

		const pickerInput = this.doc.createElement("input");
		pickerInput.type = "color";
		pickerInput.value = hexValue;
		pickerInput.addEventListener("change", () => onSelect(pickerInput.value));
		pickerWrap.appendChild(pickerInput);
		grid.appendChild(pickerWrap);
		section.appendChild(grid);
	}

	private addBackgroundPaletteSection(
		labelText: string,
		currentColor: string,
		onSelect: (color: string) => void
	): void {
		const section = this.createPropertySection(labelText);
		const grid = this.doc.createElement("div");
		grid.className = "my-sc-canvas-color-grid";
		const normalizedCurrent = (currentColor || "transparent").trim().toLowerCase();
		let matchedPreset = false;

		for (const item of BACKGROUND_PALETTE) {
			const btn = this.doc.createElement("button");
			btn.type = "button";
			btn.className = "my-sc-canvas-color-swatch";
			btn.title = item.title;
			btn.setAttribute("aria-label", item.title);
			if (item.color === "transparent") {
				btn.classList.add("is-transparent");
			} else {
				btn.style.setProperty("--swatch-color", item.preview);
			}
			const isMatch = item.color.toLowerCase() === normalizedCurrent;
			if (isMatch) matchedPreset = true;
			btn.classList.toggle("is-active", isMatch);
			btn.addEventListener("click", () => onSelect(item.color));
			grid.appendChild(btn);
		}

		const pickerWrap = this.doc.createElement("label");
		pickerWrap.className = "my-sc-canvas-color-swatch is-custom-picker";
		pickerWrap.title = "Свой цвет фона…";
		const hexValue = normalizeColorToHex(currentColor);
		pickerWrap.style.setProperty("--swatch-color", hexValue);
		pickerWrap.classList.toggle(
			"is-active",
			!matchedPreset && normalizedCurrent !== "transparent"
		);

		const pickerInput = this.doc.createElement("input");
		pickerInput.type = "color";
		pickerInput.value = hexValue;
		pickerInput.addEventListener("change", () =>
			onSelect(hexToSoftRgba(pickerInput.value, 0.22))
		);
		pickerWrap.appendChild(pickerInput);
		grid.appendChild(pickerWrap);
		section.appendChild(grid);
	}

private addSegmentedSection<T extends string | number>(
		labelText: string,
		activeValue: T,
		options: ReadonlyArray<SegmentedOption<T>>,
		onSelect: (value: T) => void
	): void {
		const section = this.createPropertySection(labelText);
		const group = this.doc.createElement("div");
		group.className = "my-sc-canvas-seg-group";

		for (const option of options) {
			const btn = this.doc.createElement("button");
			btn.type = "button";
			btn.className = "my-sc-canvas-seg-btn";
			const isActive = option.value === activeValue;
			btn.classList.toggle("is-active", isActive);
			btn.title = option.title;
			btn.setAttribute("aria-label", option.title);
			btn.setAttribute("aria-pressed", String(isActive));

			if (option.obsidianIcon) {
				setIcon(btn, option.obsidianIcon);
			} else if (option.renderSvg) {
				const svg = this.doc.createElementNS(SVG_NS, "svg");
				svg.setAttribute("viewBox", "0 0 20 20");
				svg.setAttribute("class", "my-sc-canvas-seg-svg");
				option.renderSvg(svg, this.doc);
				btn.appendChild(svg);
			} else if (option.label) {
				const span = this.doc.createElement("span");
				span.className = "my-sc-canvas-seg-text";
				span.textContent = option.label;
				btn.appendChild(span);
			}

			btn.addEventListener("click", () => onSelect(option.value));
			group.appendChild(btn);
		}

		section.appendChild(group);
	}

	private appendSvgPath(
		svg: SVGSVGElement,
		doc: Document,
		d: string,
		fill = "none"
	): void {
		const path = doc.createElementNS(SVG_NS, "path");
		path.setAttribute("d", d);
		path.setAttribute("stroke", "currentColor");
		path.setAttribute("stroke-width", "1.75");
		path.setAttribute("stroke-linecap", "round");
		path.setAttribute("stroke-linejoin", "round");
		path.setAttribute("fill", fill);
		svg.appendChild(path);
	}

	private appendStrokeWidthPreview(
		svg: SVGSVGElement,
		doc: Document,
		strokeWidth: number
	): void {
		const line = doc.createElementNS(SVG_NS, "line");
		line.setAttribute("x1", "4");
		line.setAttribute("y1", "10");
		line.setAttribute("x2", "16");
		line.setAttribute("y2", "10");
		line.setAttribute("stroke", "currentColor");
		line.setAttribute("stroke-width", String(strokeWidth));
		line.setAttribute("stroke-linecap", "round");
		svg.appendChild(line);
	}

	private appendLineDashPreview(
		svg: SVGSVGElement,
		doc: Document,
		dashArray: string
	): void {
		const line = doc.createElementNS(SVG_NS, "line");
		line.setAttribute("x1", "3");
		line.setAttribute("y1", "10");
		line.setAttribute("x2", "17");
		line.setAttribute("y2", "10");
		line.setAttribute("stroke", "currentColor");
		line.setAttribute("stroke-width", "2");
		line.setAttribute("stroke-linecap", "round");
		if (dashArray) line.setAttribute("stroke-dasharray", dashArray);
		svg.appendChild(line);
	}

	private getArrowheadSegmentOptions(): ReadonlyArray<
		SegmentedOption<NonNullable<SceneElement["startArrowhead"]>>
	> {
		return [
			{
				value: "none",
				title: "Без наконечника",
				renderSvg: (svg, doc) => this.appendSvgPath(svg, doc, "M4 10h12"),
			},
			{
				value: "arrow",
				title: "Стрелка",
				renderSvg: (svg, doc) =>
					this.appendSvgPath(svg, doc, "M4 10h11 M11 6l4 4-4 4"),
			},
			{
				value: "triangle",
				title: "Треугольник",
				renderSvg: (svg, doc) =>
					this.appendSvgPath(svg, doc, "M4 10h7 M11 6l5 4-5 4z", "currentColor"),
			},
			{
				value: "circle",
				title: "Круг",
				renderSvg: (svg, doc) => {
					this.appendSvgPath(svg, doc, "M4 10h7");
					const circle = doc.createElementNS(SVG_NS, "circle");
					circle.setAttribute("cx", "14");
					circle.setAttribute("cy", "10");
					circle.setAttribute("r", "2.6");
					circle.setAttribute("fill", "currentColor");
					svg.appendChild(circle);
				},
			},
			{
				value: "diamond",
				title: "Ромб",
				renderSvg: (svg, doc) =>
					this.appendSvgPath(
						svg,
						doc,
						"M3 10h6 M9 10l3.5-3 3.5 3-3.5 3z",
						"currentColor"
					),
			},
			{
				value: "bar",
				title: "Засечка",
				renderSvg: (svg, doc) =>
					this.appendSvgPath(svg, doc, "M4 10h10 M14 6v8"),
			},
		];
	}

	private addOpacitySliderSection(currentOpacity: number): void {
		const section = this.createPropertySection("Прозрачность");
		const row = this.doc.createElement("div");
		row.className = "my-sc-canvas-opacity-row";

		const slider = this.doc.createElement("input");
		slider.type = "range";
		slider.className = "my-sc-canvas-opacity-slider";
		slider.min = "10";
		slider.max = "100";
		slider.step = "5";
		const clamped = clamp(Math.round(currentOpacity), 10, 100);
		slider.value = String(clamped);

		const badge = this.doc.createElement("span");
		badge.className = "my-sc-canvas-opacity-value";
		badge.textContent = `${clamped}\%`;  	slider.addEventListener("input", () => { 		const val = clamp(Number(slider.value), 10, 100); 		badge.textContent = `${val}%`;
			if (!this.history.hasPendingTransaction()) {
				this.history.beginTransaction(this.scene.elements, this.selectedIds);
			}
			for (const el of this.getSelectedElements()) {
				el.opacity = val;
				el.updated = Date.now();
			}
			this.scene.appState.currentStyle.opacity = val;
			this.renderFrame();
		});

		slider.addEventListener("change", () => {
			this.commitHistory(false);
		});

		row.append(slider, badge);
		section.appendChild(row);
	}

	private addLinkPropertySection(
		currentLink: string,
		onChange: (value: string) => void
	): void {
		const section = this.createPropertySection("Ссылка");
		const input = this.doc.createElement("input");
		input.type = "text";
		input.className = "my-sc-canvas-link-input";
		input.placeholder = "[[Заметка]] или https://…";
		input.value = currentLink;
		input.addEventListener("change", () => onChange(input.value));
		section.appendChild(input);
	}

	private updateSelected(
		mutateElement: (element: SceneElement) => void,
		mutateStyle: (style: ElementStyleDefaults) => void,
		refreshPanel = false
	): void {
		const selected = this.getSelectedElements();
		if (selected.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const ctx = this.getMeasureCtx();
		for (const element of selected) {
			const anchor = getTextAnchor(element);
			mutateElement(element);
			if (ctx) fitTextElementToContent(ctx, element, anchor);
			element.updated = Date.now();
		}
		mutateStyle(this.scene.appState.currentStyle);
		this.updateBoundElementsAndFrames();
		this.commitHistory(refreshPanel);
	}

	private updateBoundElementsAndFrames(): void {
		updateBoundElements(this.scene.elements);
		this.updateFrameMembership();
	}

private toggleSelectedLock(): void {
		const selected = this.getSelectedElements();
		if (selected.length === 0) return;
		const shouldLock = selected.some((element) => !element.locked);
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		for (const element of selected) {
			element.locked = shouldLock;
			element.updated = Date.now();
		}
		this.commitHistory(true);
	}

	private copySelectedStyle(): void {
		const selected = this.getSelectedElements().filter((el) => !el.containerId);
		const sample = selected[0] ?? this.getSelectedElements()[0];
		if (!sample) {
			new Notice("Сначала выдели элемент, чтобы скопировать его стиль.");
			return;
		}
		this.copiedStyle = {
			strokeColor: sample.strokeColor,
			backgroundColor: sample.backgroundColor,
			fillStyle: sample.fillStyle,
			strokeWidth: sample.strokeWidth,
			strokeStyle: sample.strokeStyle,
			roughness: sample.roughness,
			opacity: sample.opacity,
			roundness: sample.roundness,
			fontFamily: sample.fontFamily,
			fontSize: sample.fontSize,
			textAlign: sample.textAlign,
			verticalAlign: sample.verticalAlign,
			startArrowhead: sample.startArrowhead ?? "none",
			endArrowhead: sample.endArrowhead ?? "arrow",
			curved: Boolean(sample.curved),
			elbowed: Boolean(sample.elbowed),
		};
		new Notice("Стиль скопирован.");
	}

	private pasteSelectedStyle(): void {
		const style = this.copiedStyle;
		if (!style) {
			new Notice("Буфер стиля пуст (сначала нажми Ctrl+Alt+C).");
			return;
		}
		const selected = this.getSelectedElements();
		if (selected.length === 0) {
			new Notice("Выдели элементы, к которым нужно применить стиль.");
			return;
		}
		this.updateSelected(
			(el) => {
				if (el.locked) return;
				if (!el.containerId && el.type !== "image") {
					el.strokeColor = style.strokeColor;
					el.backgroundColor = style.backgroundColor;
					el.fillStyle = style.fillStyle;
					el.strokeWidth = style.strokeWidth;
					el.strokeStyle = style.strokeStyle;
					el.roughness = style.roughness;
					el.roundness = style.roundness;
				} else if (el.type === "image") {
					el.roundness = style.roundness;
				}
				el.opacity = style.opacity;
				el.fontFamily = style.fontFamily;
				el.fontSize = style.fontSize;
				if (!el.containerId) {
					el.textAlign = style.textAlign;
					el.verticalAlign = style.verticalAlign;
				}
				if (el.type === "arrow" || el.type === "line") {
					el.curved = style.curved;
					el.elbowed = style.elbowed;
				}
				if (el.type === "arrow") {
					el.startArrowhead = style.startArrowhead;
					el.endArrowhead = style.endArrowhead;
				}
			},
			(current) => {
				Object.assign(current, style);
			},
			true
		);
	}

	private async copySceneAsPng(): Promise<void> {
		try {
			const selected = this.getSelectedElements();
			const blob = await this.renderer.exportToPngBlob(
				this.scene,
				selected.length > 0 ? selected : undefined
			);
			const nav = this.win.navigator as Navigator & {
				clipboard?: {
					write?: (items: unknown[]) => Promise<void>;
				};
			};
			const ClipboardItemCtor = (
				this.win as Window & typeof globalThis & {
					ClipboardItem?: new (items: Record<string, Blob>) => unknown;
				}
			).ClipboardItem;

			if (nav.clipboard?.write && ClipboardItemCtor) {
				await nav.clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
				new Notice(
					selected.length > 0
						? "Выделение скопировано как PNG в буфер обмена."
						: "Схема скопирована как PNG в буфер обмена."
				);
				return;
			}

			if (this.callbacks.onExportPng) {
				await this.callbacks.onExportPng(blob);
				return;
			}
			new Notice("Буфер обмена изображений недоступен на этой платформе.");
		} catch (error: unknown) {
			new Notice(
				"Не удалось экспортировать PNG: " +
					(error instanceof Error ? error.message : String(error))
			);
		}
	}

	private async exportSceneAsPngToVault(): Promise<void> {
		try {
			if (!this.callbacks.onExportPng) {
				new Notice("Сохранение PNG не настроено.");
				return;
			}
			const selected = this.getSelectedElements();
			const blob = await this.renderer.exportToPngBlob(
				this.scene,
				selected.length > 0 ? selected : undefined
			);
			await this.callbacks.onExportPng(blob);
		} catch (error: unknown) {
			new Notice(
				"Не удалось сохранить PNG: " +
					(error instanceof Error ? error.message : String(error))
			);
		}
	}
}