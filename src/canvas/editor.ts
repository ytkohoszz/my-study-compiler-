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
	hashStringSeed,
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
	constrainTo45Degrees,
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
	/** Мировые X-якоря рамки в начале правки: выравнивание решает, какой край остаётся на месте при росте текста. */
	anchor: TextAnchor;
}

interface MenuAction {
	title: string;
	icon?: string;
	onClick: () => void;
}

const SCENE_CLIPBOARD_PREFIX = "MY_STUDY_COMPILER_SCENE:";

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

function getElementMap(
	elements: readonly SceneElement[]
): Map<string, SceneElement> {
	return new Map(elements.map((element) => [element.id, element]));
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

/** Фигуры, внутри которых можно разместить привязанную подпись. */
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
	private hintEl!: HTMLDivElement;
	private controlsEl!: HTMLDivElement;
	private zoomLabelEl!: HTMLButtonElement;
	private undoBtn!: HTMLButtonElement;
	private redoBtn!: HTMLButtonElement;
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
		// Незавершённый текст сохраняется в старую сцену, пока редактор ещё привязан к её ключу
		if (this.textEditor.isOpen()) this.textEditor.close(true);
		this.scene = scene;
		this.selectedIds.clear();
		this.history.clear();
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
		const image = createSceneElement(
			"image",
			point,
			this.scene.appState.currentStyle,
			getMaxZIndex(this.scene.elements) + 1
		);
		image.fileId = fileEntry.id;
		image.width = Math.max(24, width);
		image.height = Math.max(24, height);
		image.aspectRatio = image.width / image.height;
		this.scene.elements.push(image);
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

		this.toolbarEl = this.doc.createElement("div");
		this.toolbarEl.className = "my-sc-canvas-toolbar";
		this.root.appendChild(this.toolbarEl);
		this.buildToolButtons();

		this.workspaceEl = this.doc.createElement("div");
		this.workspaceEl.className = "my-sc-canvas-workspace";
		this.root.appendChild(this.workspaceEl);

		this.propertiesEl = this.doc.createElement("aside");
		this.propertiesEl.className = "my-sc-canvas-properties is-hidden";
		this.propertiesEl.setAttribute("aria-label", "Свойства выбранных элементов");
		this.workspaceEl.appendChild(this.propertiesEl);

		this.canvasWrapEl = this.doc.createElement("div");
		this.canvasWrapEl.className = "my-sc-canvas-wrap";
		this.workspaceEl.appendChild(this.canvasWrapEl);

		this.hintEl = this.doc.createElement("div");
		this.hintEl.className = "my-sc-canvas-hint";
		this.hintEl.textContent =
			"Колесо или Пробел + перетаскивание — перемещение. Инструмент «Рука» (H).";
		this.canvasWrapEl.appendChild(this.hintEl);

		this.canvasEl = this.doc.createElement("canvas");
		this.canvasEl.className = "my-sc-canvas-surface";
		this.canvasEl.setAttribute("aria-label", "Бесконечный холст схемы");
		this.canvasWrapEl.appendChild(this.canvasEl);

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
			{ title: "Вписать выделение", icon: "focus", onClick: () => this.fitToSelection() },
			{ title: "Выбрать всё", icon: "scan", onClick: () => this.selectAll() },
			{ title: "Дублировать", icon: "copy", onClick: () => this.duplicateSelection() },
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
		this.addMenuToggle(
			"snapToGrid",
			"Привязка к сетке",
			this.scene.appState.snapToGrid,
			(value) => {
				this.scene.appState.snapToGrid = value;
				this.notifySceneAndCameraChanged();
			}
		);
		this.addMenuToggle(
			"snapToObjects",
			"Умные направляющие",
			this.scene.appState.snapToObjects,
			(value) => {
				this.scene.appState.snapToObjects = value;
				this.notifySceneAndCameraChanged();
			}
		);
		this.addMenuToggle(
			"theme",
			"Светлая тема",
			this.scene.appState.theme === "light",
			(value) => {
				const nextTheme = value ? "light" : "dark";
				this.recolorDefaultText(this.scene.appState.theme, nextTheme);
				this.scene.appState.theme = nextTheme;
				this.notifySceneAndCameraChanged();
				this.renderFrame();
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
		if (snapToObjects) {
			snapToObjects.checked = this.scene.appState.snapToObjects;
		}
		const theme = this.menuToggleByKey.get("theme");
		if (theme) theme.checked = this.scene.appState.theme === "light";
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
		this.canvasEl.addEventListener("wheel", this.onWheelBound, {
			passive: false,
		});
		this.canvasEl.addEventListener("dblclick", this.onDoubleClickBound);
		this.canvasEl.addEventListener("contextmenu", this.onContextMenuBound);
		this.root.addEventListener("keydown", this.onKeyDownBound);
		this.root.addEventListener("keyup", this.onKeyUpBound);
		this.root.addEventListener("copy", this.onCopyBound);
		this.root.addEventListener("cut", this.onCutBound);
		this.root.addEventListener("paste", this.onPasteBound);
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
	}

	private getWorldPoint(event: PointerEvent): ScenePoint {
		return pointerToWorld(event, this.canvasEl, this.scene.appState);
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
			lockButton.classList.toggle(
				"is-active",
				this.scene.appState.keepToolActive
			);
			lockButton.setAttribute(
				"aria-label",
				this.scene.appState.keepToolActive
					? "Отключить фиксацию инструмента (K)"
					: "Не переключать инструмент (K)"
			);
			lockButton.title =
				this.scene.appState.keepToolActive
					? "Отключить фиксацию инструмента (K)"
					: "Не переключать инструмент (K)";
			lockButton.replaceChildren();
			setIcon(
				lockButton,
				this.scene.appState.keepToolActive ? "lock" : "unlock"
			);
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
		// Клик по холсту завершает правку текста и затем обрабатывается как обычно
		if (this.textEditor.isOpen()) this.textEditor.close(true);
		if (event.button === 2) return;
		event.preventDefault();
		const screen = getCanvasPoint(event, this.canvasEl);
		this.activePointers.set(event.pointerId, screen);
		this.capturePointer(event.pointerId);

		if (this.activePointers.size >= 2) {
			this.startPinch();
			return;
		}

		const world = this.getWorldPoint(event);
		this.root.focus({ preventScroll: true });
		if (
			event.button === 1 ||
			this.spacePressed ||
			this.activeTool === "hand"
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
			// Без этого стирание одиночным кликом не попадало в историю и не сохранялось
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
		const handles = getTransformHandles(
			selectedElements,
			this.scene.appState.zoom
		);
		const hitHandle = hitTestHandles(
			handles,
			world,
			this.scene.appState.zoom
		);
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
		this.marqueeBox = this.makeAABB(
			world.x,
			world.y,
			world.x,
			world.y
		);
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
			let pointIndex = handle.pointIndex ?? 0;
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
				startElements: cloneElementMap(
					this.scene.elements,
					this.selectedIds
				),
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
			// Штрих карандаша не выделяется: рамка появляется только при выборе инструментом «Выбор»
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
		// Наведённые, но не нажатые указатели (мышь/перо в зоне hover) не учитываем: иначе они ложно запускают pinch
		if (this.activePointers.has(event.pointerId)) {
			this.activePointers.set(event.pointerId, screen);
		}
		if (this.activePointers.size >= 2 && this.pinchState) {
			this.updatePinch();
			return;
		}

		const current = this.interaction;
		if (!current || current.pointerId !== event.pointerId) {
			this.updateBindingPreview(pointerToWorld(event, this.canvasEl, this.scene.appState));
			return;
		}
		const world = this.getWorldPoint(event);
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
		// Карандаш остаётся активным, чтобы сразу рисовать следующий штрих
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
					// Escape выводит из любого инструмента рисования, в том числе из закреплённого карандаша
					if (this.activeTool !== "select") this.setTool("select");
					this.updatePropertiesPanel();
					this.renderFrame();
				}
				return true;
		}
	}

	private handleCopy(event: ClipboardEvent): void {
		if (isEditableTarget(event.target)) return;
		this.copySelectionToClipboard(event);
	}

	private handleCut(event: ClipboardEvent): void {
		if (isEditableTarget(event.target)) return;
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
			// The plain-text representation below remains available in browsers that reject custom MIME types.
		}
		const plainText =
			selected.length === 1 && selected[0]?.type === "text"
				? getTextValue(selected[0])
				: `${SCENE_CLIPBOARD_PREFIX}${payload}`;
		clipboard.setData("text/plain", plainText);
		return true;
	}

	private handlePaste(event: ClipboardEvent): void {
		if (isEditableTarget(event.target)) return;
		const clipboard = event.clipboardData;
		if (!clipboard) return;
		const imageItem = Array.from(clipboard.items).find(
			(item) => item.kind === "file" && item.type.startsWith("image/")
		);
		if (imageItem) {
			const file = imageItem.getAsFile();
			if (file) {
				event.preventDefault();
				void this.callbacks
					.onPasteImage(file, this.getViewportCenterWorld())
					.catch((error: unknown) => this.reportAsyncError(error));
				return;
			}
		}

		const custom = clipboard.getData("application/x-my-study-compiler-scene");
		const plainText = clipboard.getData("text/plain");
		const serialized = custom || this.stripClipboardPrefix(plainText);
		if (serialized) {
			const parsed = this.parseClipboardScene(serialized);
			if (parsed) {
				event.preventDefault();
				this.pasteElements(parsed);
				return;
			}
			if (plainText.startsWith(SCENE_CLIPBOARD_PREFIX)) {
				event.preventDefault();
				new Notice("Не удалось вставить: данные холста повреждены.");
				return;
			}
		}
		if (plainText.trim()) {
			event.preventDefault();
			this.addTextFromString(plainText, this.getViewportCenterWorld(), true);
		}
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

	/** Цвет нового текста: выбранный пользователем, иначе контрастный к теме холста. */
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

	/** Фигура, внутри которой рисуется текст: контейнер привязанной подписи или сама заметка; у свободного текста её нет. */
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

	/** Правка подписи фигуры: существующий привязанный текст либо новая подпись по центру фигуры. */
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

	/** Свободный текст появляется там, где кликнули: каретка встаёт ровно в точку клика. */
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

	/** Вставка или перетаскивание текста создаёт элемент сразу, без редактора. */
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

	/**
	 * Положение `<textarea>` в экранных координатах строится из тех же формул, что и отрисовка на холсте,
	 * поэтому текст при вводе лежит ровно поверх будущего результата.
	 */
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
			// Пустой текст не оставляет на сцене невидимых рамок
			this.removeElementAndUnbind(element);
			if (session.isNew) this.history.cancelTransaction();
			else this.commitHistory();
		} else if (!session.isNew && value === getTextValue(element)) {
			// Ничего не изменилось: без записи в историю и без лишнего сохранения
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
		// После Escape и Ctrl+Enter фокус возвращается на холст, иначе горячие клавиши молчат до следующего клика
		if (reason === "keyboard" && !this.destroyed) {
			this.root.focus({ preventScroll: true });
		}
	}

	/** При смене темы текст с цветом по умолчанию переключается на контрастный, иначе он «пропадает» на холсте. */
	private recolorDefaultText(
		from: "dark" | "light",
		to: "dark" | "light"
	): void {
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
				element.startArrowhead =
					this.scene.appState.currentStyle.startArrowhead;
				element.endArrowhead =
					this.scene.appState.currentStyle.endArrowhead;
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
		return last ? { x: element.x + last.x, y: element.y + last.y } : { x: element.x + element.width, y: element.y + element.height };
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
		// Ручку берут не точно за центр: сохраняем смещение курсора, чтобы край не «прыгал» при первом движении
		const pointer: ScenePoint = {
			x: world.x + (handle.x - interaction.startWorld.x),
			y: world.y + (handle.y - interaction.startWorld.y),
		};
		const frameElements = getSelectionFrameElements(
			Array.from(interaction.startElements.values())
		);
		const single = frameElements.length === 1 ? frameElements[0] : undefined;

		if (single && single.type === "text" && !single.containerId) {
			// Угловые и верхняя/нижняя ручки масштабируют шрифт, боковые меняют ширину блока
			const element = this.getElementById(single.id);
			const ctx = this.getMeasureCtx();
			if (element && ctx && !element.locked) {
				this.applyTextGeometry(
					element,
					resizeTextFromHandle(ctx, single, kind, pointer)
				);
			}
		} else if (single && !single.points) {
			// Одиночная фигура (в том числе повёрнутая) меняется в собственной системе координат
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
				const x2 =
					anchorX + (snapshot.x + snapshot.width - anchorX) * scaleX;
				const y2 =
					anchorY + (snapshot.y + snapshot.height - anchorY) * scaleY;
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
			Math.atan2(
				world.y - interaction.center.y,
				world.x - interaction.center.x
			) - interaction.startAngle;
		if (snapAngle) {
			const step = Math.PI / 12;
			const frameElements = getSelectionFrameElements(
				Array.from(interaction.startElements.values())
			);
			const only = frameElements.length === 1 ? frameElements[0] : undefined;
			// У одиночной фигуры к шагу привязывается итоговый угол, а не только приращение
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
		if (
			pointIndex === element.points.length - 1 &&
			element.endBinding
		) {
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
			element.endBinding = findNearestBindingTarget(
				this.getElementEndPoint(element),
				this.scene.elements,
				element.id,
				maxDistance
			)?.binding ?? null;
		}
		updateBoundElements(this.scene.elements);
	}

	private updatePathBounds(element: SceneElement): void {
		normalizeElementBounds(element);
	}

	private setPathWorldPoints(
		element: SceneElement,
		worldPoints: readonly ScenePoint[]
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
		const matches = this.scene.elements.filter((element) => {
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
		for (const element of matches) this.addGroupedSelection(element.id);
	}

	private eraseAt(point: ScenePoint): boolean {
		// Ластик стирает только то, чего касается (линию, заливку, текст), а не пустое нутро контура
		const element = getElementAtPoint(
			this.scene.elements,
			point,
			this.scene.appState.zoom,
			false
		);
		if (!element || element.locked) return false;
		if (!this.history.hasPendingTransaction()) {
			this.history.beginTransaction(this.scene.elements, this.selectedIds);
		}
		this.markElementsDeleted([element.id]);
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

	private zoomAt(point: CanvasPoint, factor: number): void {
		const oldZoom = this.scene.appState.zoom;
		const world = canvasPointToWorld(point, this.scene.appState);
		const nextZoom = clamp(oldZoom * factor, 0.1, 30);
		this.scene.appState.zoom = nextZoom;
		this.scene.appState.scrollX = point.x / nextZoom - world.x;
		this.scene.appState.scrollY = point.y / nextZoom - world.y;
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
		const distance = Math.max(1, getDistance(points[0]!, points[1]!));
		const center = getMidpoint(points[0]!, points[1]!);
		const zoom = clamp(
			this.pinchState.zoom * (distance / this.pinchState.distance),
			0.1,
			30
		);
		this.scene.appState.zoom = zoom;
		this.scene.appState.scrollX = center.x / zoom - this.pinchState.anchorWorld.x;
		this.scene.appState.scrollY = center.y / zoom - this.pinchState.anchorWorld.y;
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
		const viewport = this.canvasEl.getBoundingClientRect();
		if (viewport.width <= 0 || viewport.height <= 0) {
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
				(viewport.width - padding) / Math.max(1, bounds.width),
				(viewport.height - padding) / Math.max(1, bounds.height)
			),
			0.1,
			30
		);
		this.scene.appState.zoom = zoom;
		this.scene.appState.scrollX =
			viewport.width / (2 * zoom) - bounds.cx;
		this.scene.appState.scrollY =
			viewport.height / (2 * zoom) - bounds.cy;
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
		const pending = [id];
		while (pending.length > 0) {
			const currentId = pending.pop();
			if (!currentId || this.selectedIds.has(currentId)) continue;
			const element = this.getElementById(currentId);
			if (!element || element.isDeleted) continue;
			this.selectedIds.add(currentId);
			for (const groupId of element.groupIds ?? []) {
				for (const member of this.scene.elements) {
					if (
						!member.isDeleted &&
						member.groupIds?.includes(groupId) &&
						!this.selectedIds.has(member.id)
					) {
						pending.push(member.id);
					}
				}
			}
			if (element.containerId) pending.push(element.containerId);
			if (element.boundTextId) pending.push(element.boundTextId);
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
		const selected = this.getSelectedElements().filter((element) => !element.locked);
		if (selected.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		for (const element of selected) {
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
		const selected = this.getSelectedElements().filter((element) => !element.locked);
		if (selected.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		this.markElementsDeleted(selected.map((element) => element.id));
		this.selectedIds.clear();
		updateBoundElements(this.scene.elements);
		this.commitHistory();
	}

	private markElementsDeleted(initialIds: readonly string[]): void {
		const ids = new Set<string>();
		const pending = [...initialIds];
		while (pending.length > 0) {
			const id = pending.pop();
			if (!id || ids.has(id)) continue;
			ids.add(id);
			const target = this.getElementById(id);
			if (target?.boundTextId) pending.push(target.boundTextId);
			for (const element of this.scene.elements) {
				if (!element.isDeleted && element.containerId === id) {
					pending.push(element.id);
				}
			}
		}
		for (const id of ids) {
			const element = this.getElementById(id);
			if (!element || element.isDeleted) continue;
			element.isDeleted = true;
			element.updated = Date.now();
			this.selectedIds.delete(id);
		}
	}

	private duplicateSelection(): void {
		const selected = this.getSelectedElements();
		if (selected.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const ids = new Set(selected.map((element) => element.id));
		const copies = this.cloneElements(selected, ids, 24, 24);
		this.scene.elements.push(...copies);
		this.selectedIds = new Set(copies.map((element) => element.id));
		updateBoundElements(this.scene.elements);
		this.commitHistory();
	}

	private cloneElements(
		source: readonly SceneElement[],
		ids: ReadonlySet<string>,
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
			copy.containerId = copy.containerId && ids.has(copy.containerId)
				? idMap.get(copy.containerId) ?? null
				: null;
			copy.boundTextId = copy.boundTextId && ids.has(copy.boundTextId)
				? idMap.get(copy.boundTextId) ?? null
				: null;
			copy.frameId = copy.frameId && ids.has(copy.frameId)
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
		direction: "forward" | "backward" | "front" | "back"
	): void {
		const ordered = this.scene.elements
			.filter((element) => !element.isDeleted)
			.sort((a, b) => a.zIndex - b.zIndex);
		const selected = ordered.filter((element) => this.selectedIds.has(element.id));
		if (selected.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);

		let next: SceneElement[];
		if (direction === "front") {
			next = [...ordered.filter((element) => !this.selectedIds.has(element.id)), ...selected];
		} else if (direction === "back") {
			next = [...selected, ...ordered.filter((element) => !this.selectedIds.has(element.id))];
		} else {
			next = [...ordered];
			if (direction === "forward") {
				for (let index = next.length - 2; index >= 0; index--) {
					if (
						this.selectedIds.has(next[index]!.id) &&
						!this.selectedIds.has(next[index + 1]!.id)
					) {
						[next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
					}
				}
			} else {
				for (let index = 1; index < next.length; index++) {
					if (
						this.selectedIds.has(next[index]!.id) &&
						!this.selectedIds.has(next[index - 1]!.id)
					) {
						[next[index], next[index - 1]] = [next[index - 1]!, next[index]!];
					}
				}
			}
		}

		next.forEach((element, index) => {
			element.zIndex = index;
			element.updated = Date.now();
		});
		this.scene.elements = [
			...next,
			...this.scene.elements.filter((element) => element.isDeleted),
		];
		this.commitHistory();
	}

	private alignSelection(
		alignment:
			| "left"
			| "center-x"
			| "right"
			| "top"
			| "center-y"
			| "bottom"
	): void {
		const selected = this.getSelectedElements().filter((element) => !element.locked);
		if (selected.length < 2) return;
		const bounds = getSelectionAABB(selected);
		if (!bounds) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		for (const element of selected) {
			const box = getElementAABB(element);
			let dx = 0;
			let dy = 0;
			if (alignment === "left") dx = bounds.minX - box.minX;
			else if (alignment === "center-x") dx = bounds.cx - box.cx;
			else if (alignment === "right") dx = bounds.maxX - box.maxX;
			else if (alignment === "top") dy = bounds.minY - box.minY;
			else if (alignment === "center-y") dy = bounds.cy - box.cy;
			else dy = bounds.maxY - box.maxY;
			element.x += dx;
			element.y += dy;
			element.updated = Date.now();
		}
		updateBoundElements(this.scene.elements);
		this.commitHistory();
	}

	private distributeSelection(axis: "horizontal" | "vertical"): void {
		const selected = this.getSelectedElements().filter((element) => !element.locked);
		if (selected.length < 3) return;
		const ordered = [...selected].sort((a, b) => {
			const boxA = getElementAABB(a);
			const boxB = getElementAABB(b);
			return axis === "horizontal"
				? boxA.cx - boxB.cx
				: boxA.cy - boxB.cy;
		});
		const first = getElementAABB(ordered[0]!);
		const last = getElementAABB(ordered[ordered.length - 1]!);
		const totalExtent =
			axis === "horizontal"
				? last.maxX - first.minX
				: last.maxY - first.minY;
		const elementsExtent = ordered.reduce((total, element) => {
			const bounds = getElementAABB(element);
			return total + (axis === "horizontal" ? bounds.width : bounds.height);
		}, 0);
		const gap = (totalExtent - elementsExtent) / (ordered.length - 1);
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		let cursor = axis === "horizontal" ? first.minX : first.minY;
		for (const element of ordered) {
			const bounds = getElementAABB(element);
			const extent = axis === "horizontal" ? bounds.width : bounds.height;
			const delta = cursor - (axis === "horizontal" ? bounds.minX : bounds.minY);
			if (axis === "horizontal") element.x += delta;
			else element.y += delta;
			element.updated = Date.now();
			cursor += extent + gap;
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
			const bounds = getElementAABB(element);
			const candidates = frames
				.filter((frame) => {
					const frameBounds = getElementAABB(frame);
					return (
						bounds.cx >= frameBounds.minX &&
						bounds.cx <= frameBounds.maxX &&
						bounds.cy >= frameBounds.minY &&
						bounds.cy <= frameBounds.maxY
					);
				})
				.sort(
					(a, b) =>
						getElementAABB(a).width * getElementAABB(a).height -
						getElementAABB(b).width * getElementAABB(b).height
				);
			element.frameId = candidates[0]?.id ?? null;
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

	private commitHistory(updateProperties = true): void {
		const changed = this.history.commitTransaction(
			this.scene.elements,
			this.selectedIds
		);
		this.updateHistoryButtons();
		if (changed) {
			this.notifySceneAndCameraChanged();
			if (updateProperties) this.updatePropertiesPanel();
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
		this.propertiesEl.classList.toggle("is-hidden", selected.length === 0);
		if (selected.length === 0) return;

		const heading = this.doc.createElement("h4");
		heading.textContent =
			selected.length === 1
				? "Свойства элемента"
				: `Выбрано элементов: ${selected.length}`;
		this.propertiesEl.appendChild(heading);

		const actionRow = this.doc.createElement("div");
		actionRow.className = "my-sc-canvas-property-actions";
		this.propertiesEl.appendChild(actionRow);
		this.createButton(actionRow, "copy", "Дублировать", () =>
			this.duplicateSelection()
		);
		this.createButton(actionRow, "lock", "Блокировать или разблокировать", () =>
			this.toggleSelectedLock()
		);
		this.createButton(actionRow, "trash-2", "Удалить", () =>
			this.deleteSelection()
		);

		const first = selected[0]!;
		this.addTextProperty("Обводка", first.strokeColor, (value) => {
			const color = this.validateColor(value);
			if (!color) return;
			this.updateSelected((element) => (element.strokeColor = color), (style) => {
				style.strokeColor = color;
			});
		});
		this.addTextProperty("Фон", first.backgroundColor, (value) => {
			const color = this.validateColor(value);
			if (!color) return;
			this.updateSelected(
				(element) => (element.backgroundColor = color),
				(style) => (style.backgroundColor = color)
			);
		});
		this.addSelectProperty(
			"Заливка",
			first.fillStyle,
			[
				["solid", "Сплошная"],
				["hachure", "Штриховка"],
				["cross-hatch", "Перекрёстная"],
				["none", "Без заливки"],
			],
			(value) => {
				this.updateSelected(
					(element) => (element.fillStyle = value as SceneElement["fillStyle"]),
					(style) => (style.fillStyle = value as ElementStyleDefaults["fillStyle"])
				);
			}
		);
		this.addNumberProperty("Толщина", first.strokeWidth, 1, 16, 1, (value) => {
			this.updateSelected(
				(element) => (element.strokeWidth = value),
				(style) => (style.strokeWidth = value)
			);
		});
		this.addSelectProperty(
			"Стиль линии",
			first.strokeStyle,
			[
				["solid", "Сплошная"],
				["dashed", "Штриховая"],
				["dotted", "Точечная"],
			],
			(value) => {
				this.updateSelected(
					(element) => (element.strokeStyle = value as SceneElement["strokeStyle"]),
					(style) => (style.strokeStyle = value as ElementStyleDefaults["strokeStyle"])
				);
			}
		);
		this.addNumberProperty("Небрежность", first.roughness, 0, 2, 0.1, (value) => {
			this.updateSelected(
				(element) => (element.roughness = value),
				(style) => (style.roughness = value)
			);
		});
		this.addNumberProperty("Скругление", first.roundness, 0, 48, 1, (value) => {
			this.updateSelected(
				(element) => (element.roundness = value),
				(style) => (style.roundness = value)
			);
		});
		this.addNumberProperty("Прозрачность", first.opacity, 5, 100, 1, (value) => {
			this.updateSelected(
				(element) => (element.opacity = value),
				(style) => (style.opacity = value)
			);
		});

		if (selected.some((element) => element.type === "text" || element.text !== undefined)) {
			this.addSelectProperty(
				"Шрифт",
				first.fontFamily,
				[
					["hand", "Рукописный"],
					["normal", "Обычный"],
					["mono", "Моноширинный"],
				],
				(value) => {
					this.updateSelected(
						(element) => (element.fontFamily = value as SceneElement["fontFamily"]),
						(style) => (style.fontFamily = value as ElementStyleDefaults["fontFamily"])
					);
				}
			);
			this.addNumberProperty("Размер текста", first.fontSize, 8, 96, 1, (value) => {
				this.updateSelected(
					(element) => (element.fontSize = value),
					(style) => (style.fontSize = value)
				);
			});
			this.addSelectProperty(
				"Выравнивание",
				first.textAlign,
				[
					["left", "Слева"],
					["center", "По центру"],
					["right", "Справа"],
				],
				(value) => {
					this.updateSelected(
						(element) => (element.textAlign = value as SceneElement["textAlign"]),
						(style) => (style.textAlign = value as ElementStyleDefaults["textAlign"])
					);
				}
			);
		}

		if (selected.some((element) => element.type === "arrow")) {
			this.addSelectProperty(
				"Начало стрелки",
				first.startArrowhead ?? "none",
				this.getArrowheadOptions(),
				(value) => {
					this.updateSelected(
						(element) => (element.startArrowhead = value as SceneElement["startArrowhead"]),
						(style) => (style.startArrowhead = value as ElementStyleDefaults["startArrowhead"])
					);
				}
			);
			this.addSelectProperty(
				"Конец стрелки",
				first.endArrowhead ?? "arrow",
				this.getArrowheadOptions(),
				(value) => {
					this.updateSelected(
						(element) => (element.endArrowhead = value as SceneElement["endArrowhead"]),
						(style) => (style.endArrowhead = value as ElementStyleDefaults["endArrowhead"])
					);
				}
			);
			this.addCheckboxProperty("Скруглённая линия", Boolean(first.curved), (value) => {
				this.updateSelected(
					(element) => (element.curved = value),
					(style) => (style.curved = value)
				);
			});
			this.addCheckboxProperty("Ломаная линия", Boolean(first.elbowed), (value) => {
				this.updateSelected(
					(element) => (element.elbowed = value),
					(style) => (style.elbowed = value)
				);
			});
		}

		this.addTextProperty("Ссылка", first.link ?? "", (value) => {
			this.updateSelected(
				(element) => (element.link = value.trim() || null),
				() => undefined
			);
		});

		const layerRow = this.doc.createElement("div");
		layerRow.className = "my-sc-canvas-property-actions";
		this.propertiesEl.appendChild(layerRow);
		this.createButton(layerRow, "arrow-up", "На передний план", () =>
			this.changeLayerOrder("front")
		);
		this.createButton(layerRow, "arrow-down", "На задний план", () =>
			this.changeLayerOrder("back")
		);
	}

	private addTextProperty(
		title: string,
		value: string,
		onChange: (value: string) => void
	): void {
		const row = this.doc.createElement("label");
		row.className = "my-sc-canvas-property";
		const label = this.doc.createElement("span");
		label.textContent = title;
		const input = this.doc.createElement("input");
		input.type = "text";
		input.value = value;
		input.addEventListener("change", () => onChange(input.value));
		row.append(label, input);
		this.propertiesEl.appendChild(row);
	}

	private validateColor(value: string): string | null {
		const color = value.trim();
		if (color && this.win.CSS.supports("color", color)) return color;
		new Notice("Укажи допустимое значение цвета.");
		return null;
	}

	private addNumberProperty(
		title: string,
		value: number,
		min: number,
		max: number,
		step: number,
		onChange: (value: number) => void
	): void {
		const row = this.doc.createElement("label");
		row.className = "my-sc-canvas-property";
		const label = this.doc.createElement("span");
		label.textContent = title;
		const input = this.doc.createElement("input");
		input.type = "number";
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
		input.value = String(clamp(value, min, max));
		input.addEventListener("change", () => {
			const parsed = Number(input.value);
			if (Number.isFinite(parsed)) onChange(clamp(parsed, min, max));
		});
		row.append(label, input);
		this.propertiesEl.appendChild(row);
	}

	private addSelectProperty(
		title: string,
		value: string,
		options: Array<[string, string]>,
		onChange: (value: string) => void
	): void {
		const row = this.doc.createElement("label");
		row.className = "my-sc-canvas-property";
		const label = this.doc.createElement("span");
		label.textContent = title;
		const select = this.doc.createElement("select");
		for (const [optionValue, optionLabel] of options) {
			const option = this.doc.createElement("option");
			option.value = optionValue;
			option.textContent = optionLabel;
			select.appendChild(option);
		}
		select.value = value;
		select.addEventListener("change", () => onChange(select.value));
		row.append(label, select);
		this.propertiesEl.appendChild(row);
	}

	private addCheckboxProperty(
		title: string,
		value: boolean,
		onChange: (value: boolean) => void
	): void {
		const row = this.doc.createElement("label");
		row.className = "my-sc-canvas-property my-sc-canvas-property-check";
		const input = this.doc.createElement("input");
		input.type = "checkbox";
		input.checked = value;
		const label = this.doc.createElement("span");
		label.textContent = title;
		input.addEventListener("change", () => onChange(input.checked));
		row.append(input, label);
		this.propertiesEl.appendChild(row);
	}

	private getArrowheadOptions(): Array<[string, string]> {
		return [
			["none", "Нет"],
			["arrow", "Стрелка"],
			["triangle", "Треугольник"],
			["circle", "Круг"],
			["diamond", "Ромб"],
			["bar", "Черта"],
		];
	}

	private updateSelected(
		updateElement: (element: SceneElement) => void,
		updateStyle: (style: ElementStyleDefaults) => void
	): void {
		const selected = this.getSelectedElements();
		if (selected.length === 0) return;
		this.history.beginTransaction(this.scene.elements, this.selectedIds);
		const ctx = this.getMeasureCtx();
		for (const element of selected) {
			const anchor = getTextAnchor(element);
			updateElement(element);
			// Смена шрифта, размера или выравнивания пересчитывает рамку текста, а привязанный край остаётся на месте
			if (ctx) fitTextElementToContent(ctx, element, anchor);
			element.updated = Date.now();
		}
		updateStyle(this.scene.appState.currentStyle);
		this.updateBoundElementsAndFrames();
		this.commitHistory(false);
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
		this.commitHistory();
	}
}
