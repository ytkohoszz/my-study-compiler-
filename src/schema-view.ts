// C:\Users\user\dev\my-study-compiler\src\schema-view.ts
import { App, FuzzySuggestModal, Modal, Notice, TFile, setIcon } from "obsidian";
import {
  AnchorType,
  ArrowElement,
  ArrowHandleType,
  ArrowHead,
  ArrowRouting,
  CanvasElement,
  ElementDragSnapshot,
  ImageElement,
  Point,
  RectElement,
  ResizeHandleType,
  ResizeSnapshot,
  StudyMediaItem,
  StudyNoteItem,
  TextElement,
  ToolType,
} from "./types";
import { AnnotationManager, BoardsMap } from "./pin-manager";
import { CanvasEngine } from "./canvas-engine";
import { CanvasRenderer } from "./canvas-renderer";
import {
  IMAGE_EXTENSIONS,
  VIRTUAL_BOARD_KEY,
  cleanWikiTarget,
  extractMediaAndAnnotationMeta,
  isExternalImageUrl,
  resolveImageSource,
  saveBinaryImageToVault,
} from "./media";
import { ScanResult, flattenVisibleTree, buildNestedFilteredTree } from "./scanner";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_BOARD_W = 1400;
const DEFAULT_BOARD_H = 900;
const DOUBLE_TAP_MS = 340;
const DRAG_THRESHOLD_PX = 5;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 6.0;
const QUICK_COLORS: readonly string[] = [
  "#e5a158",
  "#4aab80",
  "#5c8df6",
  "#9c83e8",
  "#e06c75",
  "#ffffff",
];

class VaultImagePickerModal extends FuzzySuggestModal<TFile> {
  private onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Выбери картинку из хранилища для добавления на текущий холст…");
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => IMAGE_EXTENSIONS.has(f.extension.toLowerCase()));
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.onChoose(item);
  }
}

class RenameCanvasModal extends Modal {
  private initialName: string;
  private onSubmit: (nextName: string) => void;

  constructor(app: App, initialName: string, onSubmit: (nextName: string) => void) {
    super(app);
    this.initialName = initialName;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("my-sc-small-dialog");
    contentEl.empty();

    contentEl.createEl("h4", {
      cls: "my-sc-dialog-title",
      text: "Переименовать холст",
    });

    const input = contentEl.createEl("input", {
      cls: "my-sc-input my-sc-dialog-input",
      attr: {
        type: "text",
        placeholder: "Название холста…",
        value: this.initialName,
      },
    });

    const actions = contentEl.createDiv("my-sc-dialog-actions");
    const cancelBtn = actions.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "Отмена",
      attr: { type: "button" },
    });
    const saveBtn = actions.createEl("button", {
      cls: "mod-cta my-sc-chip-btn",
      text: "Сохранить",
      attr: { type: "button" },
    });

    const confirm = () => {
      const trimmed = input.value.trim();
      this.close();
      if (trimmed.length > 0) {
        this.onSubmit(trimmed);
      }
    };

    cancelBtn.onclick = () => this.close();
    saveBtn.onclick = () => confirm();

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        confirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 20);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ConfirmDeleteCanvasModal extends Modal {
  private canvasLabel: string;
  private onConfirm: () => void;

  constructor(app: App, canvasLabel: string, onConfirm: () => void) {
    super(app);
    this.canvasLabel = canvasLabel;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("my-sc-small-dialog");
    contentEl.empty();

    contentEl.createEl("h4", {
      cls: "my-sc-dialog-title",
      text: "Удалить холст?",
    });

    contentEl.createDiv({
      cls: "my-sc-dialog-desc",
      text: `Холст «${this.canvasLabel}» и все расположенные на нём элементы будут удалены из этой заметки.`,
    });

    const actions = contentEl.createDiv("my-sc-dialog-actions");
    const cancelBtn = actions.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "Отмена",
      attr: { type: "button" },
    });
    const deleteBtn = actions.createEl("button", {
      cls: "mod-warning my-sc-chip-btn",
      text: "Удалить",
      attr: { type: "button" },
    });

    cancelBtn.onclick = () => this.close();
    deleteBtn.onclick = () => {
      this.close();
      this.onConfirm();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface SchemaViewCallbacks {
  onSelectNote: (notePath: string) => void;
  onOpenNote: (notePath: string) => void;
  getMediaFolder: () => string;
}

export class ProjectSchemaView {
  private app: App;
  private container: HTMLElement;
  private callbacks: SchemaViewCallbacks;
  private manager: AnnotationManager | null = null;
  private renderer!: CanvasRenderer;

  private scan: ScanResult | null = null;
  private projectRoot: StudyNoteItem | null = null;
  private currentNote: StudyNoteItem | null = null;
  private slides: StudyMediaItem[] = [];
  private activeSlideIndex = 0;

  private scale = 1;
  private panX = 0;
  private panY = 0;
  private naturalW = DEFAULT_BOARD_W;
  private naturalH = DEFAULT_BOARD_H;
  private viewportStateBySlide = new Map<
    string,
    { scale: number; panX: number; panY: number }
  >();
  private resizeObserver: ResizeObserver | null = null;
  private lastViewportW = 0;
  private lastViewportH = 0;
  private userAdjustedViewport = false;

  private activePointers: Map<number, Point> = new Map();
  private prevPinchDistance: number | null = null;
  private prevPinchCenter: Point | null = null;
  private isPanning = false;
  private isSpacePressed = false;
  private startPanPoint: Point = { x: 0, y: 0 };
  private startTransform: Point = { x: 0, y: 0 };

  private currentTool: ToolType = "select";
  private boardsMap: BoardsMap = new Map();
  private selectedElementIds: Set<string> = new Set();
  private lastSelectedId: string | null = null;

  private lastTapTextId: string | null = null;
  private lastTapTextAt = 0;

  private isDrawing = false;
  private drawStartPoint: Point = { x: 0, y: 0 };
  private drawStartSnap: { id: string; anchor: AnchorType } | null = null;
  private previewEl: HTMLElement | SVGPathElement | null = null;

  private isMarquee = false;
  private marqueeStart: Point = { x: 0, y: 0 };
  private marqueeEl: HTMLElement | null = null;

  private pendingElementId: string | null = null;
  private pendingShiftKey = false;
  private downClientPoint: Point = { x: 0, y: 0 };
  private hasExceededDragThreshold = false;

  private isDraggingEl = false;
  private isDraggingHandle = false;
  private draggedHandleType: ArrowHandleType | null = null;

  private isResizing = false;
  private activeResizeHandle: ResizeHandleType | null = null;
  private resizeStartBBox: ResizeSnapshot = {
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    fontSize: 16,
    aspectRatio: 1,
  };

  private dragStartPoint: Point = { x: 0, y: 0 };
  private groupDragStartPositions: Map<string, ElementDragSnapshot> = new Map();

  private history: string[] = [];
  private historyIndex = -1;
  private readonly MAX_HISTORY = 40;

  private headerBarEl!: HTMLElement;
  private noteSelectEl!: HTMLSelectElement;
  private slidesBarEl!: HTMLElement;
  private addCanvasBtn!: HTMLButtonElement;
  private renameCanvasBtn!: HTMLButtonElement;
  private deleteCanvasBtn!: HTMLButtonElement;
  private zoomResetBtn!: HTMLButtonElement;
  private urlDrawerEl!: HTMLElement;
  private stageWrapEl!: HTMLElement;
  private emptyStateEl!: HTMLElement;
  private viewportEl!: HTMLElement;
  private layerEl!: HTMLElement;
  private boardBgEl!: HTMLElement;
  private imgEl!: HTMLImageElement;
  private svgLayerEl!: SVGSVGElement;
  private elementsLayerEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private propertiesPanelEl!: HTMLElement;
  private bringFrontBtn!: HTMLButtonElement;
  private sendBackBtn!: HTMLButtonElement;
  private deleteBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;

  private keyDownHandler?: (e: KeyboardEvent) => void;
  private keyUpHandler?: (e: KeyboardEvent) => void;
  private windowBlurHandler?: () => void;
  private pasteHandler?: (e: ClipboardEvent) => void;

  constructor(
    app: App,
    container: HTMLElement,
    callbacks: SchemaViewCallbacks
  ) {
    this.app = app;
    this.container = container;
    this.callbacks = callbacks;
    this.buildDOM();
  }

  private buildDOM(): void {
    this.container.empty();
    this.container.addClass("my-sc-schema-host");

    this.headerBarEl = this.container.createDiv("my-sc-schema-header");

    const leftControls = this.headerBarEl.createDiv("my-sc-schema-header-left");
    this.noteSelectEl = leftControls.createEl("select", {
      cls: "dropdown my-sc-schema-note-select",
      attr: { title: "Узел проекта для рисования схемы или аннотации" },
    });
    this.noteSelectEl.onchange = () => {
      const nextPath = this.noteSelectEl.value;
      if (nextPath) this.callbacks.onSelectNote(nextPath);
    };

    this.slidesBarEl = leftControls.createDiv("my-sc-schema-slides");

    // Минималистичные кнопки управления холстами: Добавить, Переименовать, Удалить
    const canvasMgmtGroup = leftControls.createDiv("my-sc-canvas-mgmt");

    this.addCanvasBtn = canvasMgmtGroup.createEl("button", {
      cls: "my-sc-canvas-mgmt-btn",
      attr: {
        type: "button",
        title: "Добавить холст",
        "aria-label": "Добавить холст",
      },
    });
    setIcon(this.addCanvasBtn, "plus");
    this.addCanvasBtn.onclick = () => {
      void this.createNewBoardSlide();
    };

    this.renameCanvasBtn = canvasMgmtGroup.createEl("button", {
      cls: "my-sc-canvas-mgmt-btn",
      attr: {
        type: "button",
        title: "Переименовать холст",
        "aria-label": "Переименовать холст",
      },
    });
    setIcon(this.renameCanvasBtn, "pencil");
    this.renameCanvasBtn.onclick = () => {
      this.promptRenameActiveCanvas();
    };

    this.deleteCanvasBtn = canvasMgmtGroup.createEl("button", {
      cls: "my-sc-canvas-mgmt-btn is-danger",
      attr: {
        type: "button",
        title: "Удалить холст",
        "aria-label": "Удалить холст",
      },
    });
    setIcon(this.deleteCanvasBtn, "trash-2");
    this.deleteCanvasBtn.onclick = () => {
      this.promptDeleteActiveCanvas();
    };

    const rightControls = this.headerBarEl.createDiv("my-sc-schema-header-right");

    const addVaultImgBtn = rightControls.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "🖼 Картинка",
      attr: {
        type: "button",
        title: "Добавить картинку из хранилища на текущий открытый холст",
      },
    });
    addVaultImgBtn.onclick = () => {
      if (!this.currentNote || this.slides.length === 0) return;
      new VaultImagePickerModal(this.app, async (pickedFile) => {
        await this.addImageElementToCurrentCanvas(pickedFile.path);
      }).open();
    };

    const attachUrlBtn = rightControls.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "🌐 URL",
      attr: {
        type: "button",
        title: "Добавить изображение по прямой ссылке на текущий холст",
      },
    });
    attachUrlBtn.onclick = () => {
      if (this.slides.length === 0) return;
      this.urlDrawerEl.toggleClass(
        "is-hidden",
        !this.urlDrawerEl.hasClass("is-hidden")
      );
    };

    this.undoBtn = rightControls.createEl("button", {
      cls: "my-sc-icon-btn",
      attr: { type: "button", title: "Отменить (Ctrl+Z)", "aria-label": "Отменить" },
    });
    setIcon(this.undoBtn, "undo-2");
    this.undoBtn.onclick = () => this.undo();

    this.redoBtn = rightControls.createEl("button", {
      cls: "my-sc-icon-btn",
      attr: { type: "button", title: "Повторить (Ctrl+Shift+Z)", "aria-label": "Повторить" },
    });
    setIcon(this.redoBtn, "redo-2");
    this.redoBtn.onclick = () => this.redo();

    // Группа управления масштабом: «−», «100%», «+», «Вписать всё»
    const zoomGroup = rightControls.createDiv("my-sc-zoom-group");

    const zoomOutBtn = zoomGroup.createEl("button", {
      cls: "my-sc-icon-btn my-sc-zoom-btn",
      attr: { type: "button", title: "Отдалить (−)", "aria-label": "Отдалить" },
    });
    setIcon(zoomOutBtn, "minus");
    zoomOutBtn.onclick = () => this.zoomByCenter(1 / 1.25);

    this.zoomResetBtn = zoomGroup.createEl("button", {
      cls: "my-sc-zoom-pct-btn",
      text: "100%",
      attr: {
        type: "button",
        title: "Масштаб 100%",
        "aria-label": "Масштаб 100%",
      },
    });
    this.zoomResetBtn.onclick = () => this.resetZoomTo100();

    const zoomInBtn = zoomGroup.createEl("button", {
      cls: "my-sc-icon-btn my-sc-zoom-btn",
      attr: { type: "button", title: "Приблизить (+)", "aria-label": "Приблизить" },
    });
    setIcon(zoomInBtn, "plus");
    zoomInBtn.onclick = () => this.zoomByCenter(1.25);

    const fitBtn = zoomGroup.createEl("button", {
      cls: "my-sc-icon-btn my-sc-zoom-btn",
      attr: {
        type: "button",
        title: "Вписать всё",
        "aria-label": "Вписать всё",
      },
    });
    setIcon(fitBtn, "maximize");
    fitBtn.onclick = () => {
      this.userAdjustedViewport = false;
      this.fitToScreen();
    };

    this.urlDrawerEl = this.container.createDiv("my-sc-schema-url-bar is-hidden");
    const urlInput = this.urlDrawerEl.createEl("input", {
      cls: "my-sc-input",
      attr: {
        type: "url",
        placeholder:
          "Вставь прямую ссылку на картинку (https://...) или нажми Ctrl+V на холсте…",
      },
    });
    const urlAddBtn = this.urlDrawerEl.createEl("button", {
      cls: "mod-cta my-sc-chip-btn",
      text: "Добавить на холст",
      attr: { type: "button" },
    });
    urlAddBtn.onclick = async () => {
      const rawUrl = urlInput.value.trim();
      if (!rawUrl || !this.currentNote) return;
      urlInput.value = "";
      this.urlDrawerEl.addClass("is-hidden");
      await this.addImageElementToCurrentCanvas(rawUrl);
    };

    this.stageWrapEl = this.container.createDiv("mni-container my-sc-schema-stage");
    this.viewportEl = this.stageWrapEl.createDiv({ cls: "mni-viewport" });
    this.layerEl = this.viewportEl.createDiv({ cls: "mni-canvas-layer" });

    this.boardBgEl = this.layerEl.createDiv({ cls: "my-sc-board-surface" });
    this.imgEl = this.layerEl.createEl("img", { cls: "mni-image is-hidden" });
    this.elementsLayerEl = this.layerEl.createDiv({
      cls: "mni-elements-layer",
    });
    this.svgLayerEl = document.createElementNS(SVG_NS, "svg");
    this.svgLayerEl.classList.add("mni-svg-layer");
    this.layerEl.appendChild(this.svgLayerEl);

    // Пустое состояние, когда у заметки удалены все холсты
    this.emptyStateEl = this.stageWrapEl.createDiv(
      "my-sc-schema-empty-state is-hidden"
    );
    this.emptyStateEl.createDiv({
      cls: "my-sc-schema-empty-text",
      text: "У этой заметки пока нет открытых холстов.",
    });
    const emptyAddBtn = this.emptyStateEl.createEl("button", {
      cls: "mod-cta my-sc-chip-btn",
      text: "＋ Добавить холст",
      attr: { type: "button" },
    });
    emptyAddBtn.onclick = () => {
      void this.createNewBoardSlide();
    };

    this.renderer = new CanvasRenderer(
      this.elementsLayerEl,
      this.svgLayerEl,
      "",
      (linkHref, newLeaf) => this.handleInternalWikiLink(linkHref, newLeaf),
      (srcKey) =>
        resolveImageSource(this.app, srcKey, this.currentNote?.path ?? "").src
    );

    this.renderToolbar(this.stageWrapEl);
    this.propertiesPanelEl = this.stageWrapEl.createDiv({
      cls: "mni-properties-panel is-hidden",
    });

    this.bindPointerEvents(this.viewportEl);
    this.bindDragAndDropEvents(this.viewportEl);
    this.bindKeyboardAndPasteEvents();
    this.setTool("select");

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const w = Math.round(entry.contentRect.width);
        const h = Math.round(entry.contentRect.height);
        if (w <= 0 || h <= 0) return;
        const sizeChanged =
          Math.abs(w - this.lastViewportW) > 2 || Math.abs(h - this.lastViewportH) > 2;
        if (!sizeChanged) return;
        const wasZero = this.lastViewportW === 0 || this.lastViewportH === 0;
        this.lastViewportW = w;
        this.lastViewportH = h;
        if (wasZero || !this.userAdjustedViewport) {
          this.fitToScreen();
        }
      });
      this.resizeObserver.observe(this.viewportEl);
    }
  }

  public async update(
    scan: ScanResult,
    projectRoot: StudyNoteItem,
    targetNote: StudyNoteItem
  ): Promise<void> {
    const noteChanged = this.currentNote?.path !== targetNote.path;
    if (noteChanged) {
      this.saveCurrentSlideViewportState();
      if (this.manager) {
        await this.manager.flushSave(this.boardsMap);
      }
    }

    this.scan = scan;
    this.projectRoot = projectRoot;
    this.currentNote = targetNote;

    this.populateNoteSelect();

    if (noteChanged || !this.manager) {
      this.manager = new AnnotationManager(this.app, targetNote.file);
      this.renderer.setNotePath(targetNote.path);
      await this.reloadCurrentNoteMedia();
    } else {
      window.requestAnimationFrame(() => this.fitToScreen());
    }
  }

  private getSlideViewportCacheKey(slideKey?: string): string {
    const k = slideKey ?? this.slides[this.activeSlideIndex]?.key ?? "";
    return `${this.currentNote?.path ?? ""}::${k}`;
  }

  private saveCurrentSlideViewportState(): void {
    const slide = this.slides[this.activeSlideIndex];
    if (!slide || !this.currentNote) return;
    this.viewportStateBySlide.set(this.getSlideViewportCacheKey(slide.key), {
      scale: this.scale,
      panX: this.panX,
      panY: this.panY,
    });
  }

  private populateNoteSelect(): void {
    this.noteSelectEl.empty();
    if (!this.scan || !this.projectRoot) return;

    const addOption = (item: StudyNoteItem, depth: number) => {
      const indent = "\u00A0\u00A0".repeat(depth);
      const mediaBadge =
        item.mediaItems.length > 0 || item.annotationCount > 0
          ? ` [🖼 ${item.mediaItems.length}${item.annotationCount > 0 ? ` · ☊ ${item.annotationCount}` : ""}]`
          : "";
      const opt = this.noteSelectEl.createEl("option", {
        text: `${indent}${depth > 0 ? "↳ " : "📁 "}${item.name}${mediaBadge}`,
        value: item.path,
      });
      if (this.currentNote?.path === item.path) opt.selected = true;
    };

    addOption(this.projectRoot, 0);
    const tree = buildNestedFilteredTree(this.projectRoot, this.scan, null, {
      query: "",
      mode: "all",
      typeFilter: "",
    });
    for (const node of flattenVisibleTree(tree)) {
      addOption(node.item, node.depth + 1);
    }
  }

  private refreshSlidesDefaultLabels(): void {
    this.slides.forEach((slide, idx) => {
      const board = this.boardsMap.get(slide.key);
      const custom = board?.title?.trim() || slide.customTitle?.trim();
      if (custom) {
        slide.customTitle = custom;
        slide.label = custom;
      } else {
        slide.customTitle = undefined;
        slide.label = `Холст ${idx + 1}`;
      }
    });
  }

  private async reloadCurrentNoteMedia(preferKey?: string): Promise<void> {
    if (!this.currentNote || !this.manager) return;

    this.boardsMap = await this.manager.loadBoards(
      DEFAULT_BOARD_W,
      DEFAULT_BOARD_H
    );

    const { mediaItems } = extractMediaAndAnnotationMeta(
      this.app,
      this.currentNote.file
    );

    this.slides = [...mediaItems];

    for (const [key, board] of this.boardsMap.entries()) {
      if (board.deleted) continue;
      if (!this.slides.some((s) => s.key === key)) {
        this.slides.push({
          key,
          label: board.title || `Холст ${this.slides.length + 1}`,
          customTitle: board.title,
          src: "",
          kind: "board",
        });
      }
    }

    const allDeletedExplicitly =
      this.boardsMap.size > 0 &&
      Array.from(this.boardsMap.values()).every((b) => b.deleted === true);

    if (this.slides.length === 0 && !allDeletedExplicitly) {
      this.slides.push({
        key: VIRTUAL_BOARD_KEY,
        label: "Холст 1",
        src: "",
        kind: "board",
      });
    }

    this.refreshSlidesDefaultLabels();

    if (this.slides.length === 0) {
      this.activeSlideIndex = -1;
    } else if (preferKey) {
      const idx = this.slides.findIndex((s) => s.key === preferKey);
      this.activeSlideIndex = idx >= 0 ? idx : 0;
    } else if (
      this.activeSlideIndex < 0 ||
      this.activeSlideIndex >= this.slides.length
    ) {
      this.activeSlideIndex = 0;
    }

    this.selectedElementIds.clear();
    this.lastSelectedId = null;
    this.renderSlidesChips();
    await this.loadActiveSlide();
  }

  private syncCanvasMgmtButtonsState(): void {
    const hasActiveCanvas =
      this.slides.length > 0 &&
      this.activeSlideIndex >= 0 &&
      this.activeSlideIndex < this.slides.length;

    if (this.renameCanvasBtn) {
      this.renameCanvasBtn.disabled = !hasActiveCanvas;
      this.renameCanvasBtn.classList.toggle("is-disabled", !hasActiveCanvas);
    }
    if (this.deleteCanvasBtn) {
      this.deleteCanvasBtn.disabled = !hasActiveCanvas;
      this.deleteCanvasBtn.classList.toggle("is-disabled", !hasActiveCanvas);
    }
    this.emptyStateEl?.toggleClass("is-hidden", hasActiveCanvas);
    this.viewportEl?.toggleClass("is-hidden", !hasActiveCanvas);
    this.toolbarEl?.toggleClass("is-hidden", !hasActiveCanvas);
    if (!hasActiveCanvas) {
      this.propertiesPanelEl?.addClass("is-hidden");
    }
  }

  private async createNewBoardSlide(): Promise<void> {
    if (!this.currentNote || !this.manager) return;

    this.saveCurrentSlideViewportState();

    let n = 1;
    let nextKey = VIRTUAL_BOARD_KEY;
    const usedKeys = new Set<string>([
      ...this.slides.map((s) => s.key),
      ...Array.from(this.boardsMap.entries())
        .filter(([, b]) => !b.deleted)
        .map(([k]) => k),
    ]);
    while (usedKeys.has(nextKey)) {
      n++;
      nextKey = `__board_${n}__`;
    }

    this.boardsMap.set(nextKey, {
      elements: [],
    });

    this.slides.push({
      key: nextKey,
      label: `Холст ${this.slides.length + 1}`,
      src: "",
      kind: "board",
    });
    this.refreshSlidesDefaultLabels();

    this.activeSlideIndex = this.slides.length - 1;
    this.selectedElementIds.clear();
    this.lastSelectedId = null;
    this.renderSlidesChips();
    await this.loadActiveSlide();
    this.manager.scheduleSave(this.boardsMap);
  }

  private promptRenameActiveCanvas(): void {
    const slide = this.slides[this.activeSlideIndex];
    if (!slide || !this.manager) return;

    const currentLabel = slide.customTitle || slide.label;
    new RenameCanvasModal(this.app, currentLabel, (nextName) => {
      const cleanName = nextName.trim();
      if (!cleanName) return;

      let board = this.boardsMap.get(slide.key);
      if (!board) {
        board = { elements: [] };
        this.boardsMap.set(slide.key, board);
      }
      board.title = cleanName;
      slide.customTitle = cleanName;
      slide.label = cleanName;

      this.renderSlidesChips();
      this.manager?.scheduleSave(this.boardsMap);
    }).open();
  }

  private isKeyBackedByNoteEmbedOrYaml(key: string): boolean {
    if (!this.currentNote) return false;
    const cache = this.app.metadataCache.getFileCache(this.currentNote.file);
    for (const em of cache?.embeds ?? []) {
      const linkPath = cleanWikiTarget(em.link);
      if (!linkPath) continue;
      if (linkPath === key) return true;
      const dest = this.app.metadataCache.getFirstLinkpathDest(
        linkPath,
        this.currentNote.path
      );
      if (dest && (dest.name === key || dest.path === key)) return true;
    }
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    if (fm) {
      for (const prop of [
        "изображение",
        "изображения",
        "картинка",
        "схема",
        "медиа",
        "обложка",
        "image",
        "media",
      ]) {
        const raw = fm[prop];
        const vals = Array.isArray(raw)
          ? raw.map(String)
          : typeof raw === "string"
            ? [raw]
            : [];
        for (const v of vals) {
          const cl = cleanWikiTarget(v);
          if (cl === key || v.trim() === key) return true;
        }
      }
    }
    return false;
  }

  private promptDeleteActiveCanvas(): void {
    const slide = this.slides[this.activeSlideIndex];
    if (!slide || !this.manager) return;

    new ConfirmDeleteCanvasModal(this.app, slide.label, async () => {
      const targetKey = slide.key;
      this.viewportStateBySlide.delete(
        this.getSlideViewportCacheKey(targetKey)
      );

      if (this.isKeyBackedByNoteEmbedOrYaml(targetKey)) {
        this.boardsMap.set(targetKey, {
          elements: [],
          deleted: true,
        });
      } else {
        this.boardsMap.delete(targetKey);
      }

      this.slides.splice(this.activeSlideIndex, 1);
      this.refreshSlidesDefaultLabels();

      if (this.slides.length === 0) {
        this.activeSlideIndex = -1;
      } else if (this.activeSlideIndex >= this.slides.length) {
        this.activeSlideIndex = this.slides.length - 1;
      }

      this.selectedElementIds.clear();
      this.lastSelectedId = null;
      this.renderSlidesChips();
      await this.loadActiveSlide();
      this.manager?.scheduleSave(this.boardsMap);
    }).open();
  }

  private renderSlidesChips(): void {
    this.slidesBarEl.empty();
    this.slides.forEach((slide, idx) => {
      const isAct = idx === this.activeSlideIndex;
      const chip = this.slidesBarEl.createEl("button", {
        cls: `my-sc-filter-chip ${isAct ? "is-active" : ""}`,
        text: slide.label,
        attr: { type: "button", title: slide.label },
      });
      chip.onclick = async () => {
        if (this.activeSlideIndex === idx) return;
        this.saveCurrentSlideViewportState();
        this.activeSlideIndex = idx;
        this.selectedElementIds.clear();
        this.lastSelectedId = null;
        this.renderSlidesChips();
        await this.loadActiveSlide();
      };
    });
    this.syncCanvasMgmtButtonsState();
  }

  private syncBoardSurfaceBounds(): void {
    const list = this.getCurrentElements();
    let maxRight = DEFAULT_BOARD_W;
    let maxBottom = DEFAULT_BOARD_H;

    for (const el of list) {
      const bbox = CanvasEngine.getElementBBox(el);
      maxRight = Math.max(maxRight, Math.round(bbox.x + bbox.width + 160));
      maxBottom = Math.max(maxBottom, Math.round(bbox.y + bbox.height + 160));
    }

    this.naturalW = maxRight;
    this.naturalH = maxBottom;
    this.boardBgEl.style.width = `${this.naturalW}px`;
    this.boardBgEl.style.height = `${this.naturalH}px`;
    this.renderer.syncLayersSize(this.naturalW, this.naturalH);
  }

  private async loadActiveSlide(): Promise<void> {
    this.syncCanvasMgmtButtonsState();

    const slide = this.slides[this.activeSlideIndex];
    if (!slide || !this.manager) {
      this.elementsLayerEl.empty();
      this.renderer.renderAll([], this.selectedElementIds);
      return;
    }

    this.imgEl.addClass("is-hidden");
    this.boardBgEl.removeClass("is-hidden");

    let board = this.boardsMap.get(slide.key);
    if (!board || board.deleted) {
      board = {
        title: slide.customTitle,
        elements: [],
      };
    }

    const list = [...board.elements];

    // Автоматическая миграция старого холста с одиночной картинкой в элемент ImageElement
    const hasImageElement = list.some((el) => el.type === "image");
    if (
      !hasImageElement &&
      (slide.kind === "vault" || slide.kind === "external") &&
      slide.src
    ) {
      const dims = await this.probeImageDimensions(slide.src);
      const w = dims.width || 800;
      const h = dims.height || 600;
      const migratedImg: ImageElement = {
        id: `img_migrated_${Date.now()}`,
        type: "image",
        x: 0,
        y: 0,
        width: w,
        height: h,
        srcKey: slide.key,
        aspectRatio: Number((w / Math.max(1, h)).toFixed(4)),
      };
      list.unshift(migratedImg);
      board.elements = list;
      this.boardsMap.set(slide.key, board);
      this.manager.scheduleSave(this.boardsMap);
    }

    CanvasEngine.syncArrowsToBlocks(this.getCurrentElements());
    this.syncBoardSurfaceBounds();
    this.resetHistory();
    this.updatePropertiesPanel();
    this.updateDeleteButton();
    this.renderElements();

    const savedVp = this.viewportStateBySlide.get(
      this.getSlideViewportCacheKey(slide.key)
    );
    if (savedVp) {
      this.scale = savedVp.scale;
      this.panX = savedVp.panX;
      this.panY = savedVp.panY;
      this.userAdjustedViewport = true;
      this.applyTransform();
    } else {
      this.userAdjustedViewport = false;
      window.requestAnimationFrame(() => this.fitToScreen());
    }
  }

  private probeImageDimensions(
    src: string
  ): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      if (!src) {
        resolve({ width: 640, height: 420 });
        return;
      }
      const probe = new Image();
      const done = (w: number, h: number) => {
        probe.onload = null;
        probe.onerror = null;
        resolve({ width: w, height: h });
      };
      probe.onload = () => {
        done(probe.naturalWidth || 640, probe.naturalHeight || 420);
      };
      probe.onerror = () => {
        done(640, 420);
      };
      probe.src = src;
    });
  }

  /**
   * Добавляет картинку на ТЕКУЩИЙ открытый холст.
   */
  public async addImageElementToCurrentCanvas(
    srcKey: string,
    dropCanvasPoint?: Point
  ): Promise<void> {
    if (!this.currentNote) return;

    if (this.slides.length === 0) {
      await this.createNewBoardSlide();
    }

    const resolved = resolveImageSource(
      this.app,
      srcKey,
      this.currentNote.path
    );
    const dims = await this.probeImageDimensions(resolved.src);
    let w = dims.width || 560;
    let h = dims.height || 380;
    const ratio = Number((w / Math.max(1, h)).toFixed(4));

    const maxInitialSide = 760;
    if (w > maxInitialSide || h > maxInitialSide) {
      if (w >= h) {
        w = maxInitialSide;
        h = Math.max(40, Math.round(w / ratio));
      } else {
        h = maxInitialSide;
        w = Math.max(40, Math.round(h * ratio));
      }
    }

    const list = this.getCurrentElements();
    let x = 60;
    let y = 60;

    if (dropCanvasPoint) {
      x = Math.max(0, Math.round(dropCanvasPoint.x - w / 2));
      y = Math.max(0, Math.round(dropCanvasPoint.y - h / 2));
    } else if (list.length > 0) {
      const vpRect = this.viewportEl.getBoundingClientRect();
      if (vpRect.width > 0 && vpRect.height > 0) {
        const centerPt = CanvasEngine.screenToCanvas(
          vpRect.left + vpRect.width / 2,
          vpRect.top + vpRect.height / 2,
          vpRect,
          this.panX,
          this.panY,
          this.scale
        );
        const offset = (list.length % 6) * 28;
        x = Math.max(20, Math.round(centerPt.x - w / 2 + offset));
        y = Math.max(20, Math.round(centerPt.y - h / 2 + offset));
      }
    }

    const newImg: ImageElement = {
      id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: "image",
      x,
      y,
      width: w,
      height: h,
      srcKey,
      aspectRatio: ratio,
    };

    list.push(newImg);
    this.setCurrentElements(list);
    this.syncBoardSurfaceBounds();

    this.setTool("select");
    this.selectedElementIds.clear();
    this.selectedElementIds.add(newImg.id);
    this.lastSelectedId = newImg.id;
    this.updateDeleteButton();
    this.updatePropertiesPanel();
    this.commitHistory();
    this.renderElements(newImg.id);
  }

  private getCurrentElements(): CanvasElement[] {
    const slide = this.slides[this.activeSlideIndex];
    if (!slide) return [];
    let board = this.boardsMap.get(slide.key);
    if (!board) {
      board = { title: slide.customTitle, elements: [] };
      this.boardsMap.set(slide.key, board);
    }
    return board.elements;
  }

  private setCurrentElements(list: CanvasElement[]): void {
    const slide = this.slides[this.activeSlideIndex];
    if (!slide) return;
    let board = this.boardsMap.get(slide.key);
    if (!board) {
      board = { title: slide.customTitle, elements: list };
      this.boardsMap.set(slide.key, board);
    } else {
      board.elements = list;
    }
  }

  private renderElements(freshElementId?: string | null): void {
    this.renderer.renderAll(
      this.getCurrentElements(),
      this.selectedElementIds,
      freshElementId
    );
  }

  private handleInternalWikiLink(linkHref: string, newLeaf: boolean): void {
    if (!this.currentNote) return;
    const clean = linkHref.split("#")[0]?.split("|")[0]?.trim();
    if (!clean) return;
    const dest = this.app.metadataCache.getFirstLinkpathDest(
      clean,
      this.currentNote.path
    );
    if (dest instanceof TFile) {
      if (!newLeaf && this.scan?.byPath.has(dest.path)) {
        this.callbacks.onSelectNote(dest.path);
      } else {
        this.callbacks.onOpenNote(dest.path);
      }
    }
  }

  private resetHistory(): void {
    this.history = [];
    this.historyIndex = -1;
    this.commitHistory(false);
  }

  private serializeBoardsForHistory(): string {
    const entries: Array<[string, { title?: string; deleted?: boolean; elements: CanvasElement[] }]> = [];
    for (const [k, b] of this.boardsMap.entries()) {
      entries.push([
        k,
        {
          title: b.title,
          deleted: b.deleted,
          elements: b.elements,
        },
      ]);
    }
    return JSON.stringify(entries);
  }

  private commitHistory(persist = true): void {
    const currentState = this.serializeBoardsForHistory();
    if (
      this.historyIndex === -1 ||
      this.history[this.historyIndex] !== currentState
    ) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(currentState);
      this.historyIndex++;
      if (this.history.length > this.MAX_HISTORY) {
        this.history.shift();
        this.historyIndex--;
      }
      if (persist && this.manager) {
        this.manager.scheduleSave(this.boardsMap);
      }
      this.updateUndoButtons();
    }
  }

  private undo(): void {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.restoreStateFromHistory();
    }
  }

  private redo(): void {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.restoreStateFromHistory();
    }
  }

  private restoreStateFromHistory(): void {
    const stateStr = this.history[this.historyIndex];
    if (!stateStr) return;
    const parsed = JSON.parse(stateStr) as Array<
      [string, { title?: string; deleted?: boolean; elements: CanvasElement[] }]
    >;
    this.boardsMap = new Map(parsed);
    this.selectedElementIds.clear();
    this.lastSelectedId = null;
    this.syncBoardSurfaceBounds();
    this.updatePropertiesPanel();
    this.renderElements();
    this.manager?.scheduleSave(this.boardsMap);
    this.updateUndoButtons();
  }

  private updateUndoButtons(): void {
    if (this.undoBtn) this.undoBtn.disabled = this.historyIndex <= 0;
    if (this.redoBtn) {
      this.redoBtn.disabled = this.historyIndex >= this.history.length - 1;
    }
    this.updateDeleteButton();
  }

  private updateDeleteButton(): void {
    const has = this.selectedElementIds.size > 0;
    if (this.deleteBtn) {
      this.deleteBtn.disabled = !has;
      this.deleteBtn.classList.toggle("is-disabled", !has);
    }
    if (this.bringFrontBtn) {
      this.bringFrontBtn.disabled = !has;
      this.bringFrontBtn.classList.toggle("is-disabled", !has);
    }
    if (this.sendBackBtn) {
      this.sendBackBtn.disabled = !has;
      this.sendBackBtn.classList.toggle("is-disabled", !has);
    }
  }

  private bringSelectedToFront(): void {
    if (this.selectedElementIds.size === 0) return;
    const list = this.getCurrentElements();
    const unselected = list.filter((el) => !this.selectedElementIds.has(el.id));
    const selected = list.filter((el) => this.selectedElementIds.has(el.id));
    this.setCurrentElements([...unselected, ...selected]);
    this.renderElements();
    this.commitHistory();
  }

  private sendSelectedToBack(): void {
    if (this.selectedElementIds.size === 0) return;
    const list = this.getCurrentElements();
    const selected = list.filter((el) => this.selectedElementIds.has(el.id));
    const unselected = list.filter((el) => !this.selectedElementIds.has(el.id));
    this.setCurrentElements([...selected, ...unselected]);
    this.renderElements();
    this.commitHistory();
  }

  private renderToolbar(parent: HTMLElement): void {
    this.toolbarEl = parent.createDiv({ cls: "mni-toolbar" });
    const tools: { id: ToolType; icon: string; label: string; hotkey: string }[] =
      [
        { id: "select", icon: "🖐️", label: "Выделение", hotkey: "V" },
        { id: "pan", icon: "✥", label: "Панорама", hotkey: "H" },
        { id: "rect", icon: "⬜", label: "Прямоугольник (рамка)", hotkey: "R" },
        { id: "arrow", icon: "↗️", label: "Стрелка", hotkey: "A" },
        { id: "text", icon: "T", label: "Текст / [[Ссылка]]", hotkey: "T" },
      ];

    tools.forEach((t) => {
      const btn = this.toolbarEl.createEl("button", {
        cls: "mni-tool-btn",
        text: t.icon,
        attr: { type: "button", title: `${t.label} (${t.hotkey})` },
      });
      btn.dataset.tool = t.id;
      btn.onclick = () => this.setTool(t.id);
    });

    this.bringFrontBtn = this.toolbarEl.createEl("button", {
      cls: "mni-tool-btn mni-tool-layer is-disabled",
      text: "⬆",
      attr: { type: "button", title: "На передний план" },
    });
    this.bringFrontBtn.onclick = () => this.bringSelectedToFront();

    this.sendBackBtn = this.toolbarEl.createEl("button", {
      cls: "mni-tool-btn mni-tool-layer is-disabled",
      text: "⬇",
      attr: { type: "button", title: "На задний план" },
    });
    this.sendBackBtn.onclick = () => this.sendSelectedToBack();

    this.deleteBtn = this.toolbarEl.createEl("button", {
      cls: "mni-tool-btn mni-tool-delete is-disabled",
      text: "✖",
      attr: { type: "button", title: "Удалить выбранное (Delete / Backspace)" },
    });
    this.deleteBtn.onclick = () => this.deleteSelected();
  }

  private setTool(tool: ToolType): void {
    this.currentTool = tool;
    if (tool !== "select") {
      this.selectedElementIds.clear();
      this.lastSelectedId = null;
    }
    this.updateDeleteButton();
    this.updatePropertiesPanel();
    this.renderer.updateSelectionStates(
      this.getCurrentElements(),
      this.selectedElementIds
    );

    this.viewportEl.classList.remove(
      "is-pan-mode",
      "is-rect-mode",
      "is-text-mode",
      "is-select-mode",
      "is-arrow-mode"
    );
    this.viewportEl.classList.add(`is-${tool}-mode`);

    this.toolbarEl.querySelectorAll(".mni-tool-btn").forEach((btn) => {
      const btnEl = btn as HTMLElement;
      if (!btnEl.dataset.tool) return;
      btnEl.classList.toggle("is-active", btnEl.dataset.tool === tool);
    });
  }

  private updatePropertiesPanel(): void {
    this.propertiesPanelEl.empty();

    if (!this.lastSelectedId || this.currentTool !== "select") {
      this.propertiesPanelEl.classList.add("is-hidden");
      return;
    }

    const elements = this.getCurrentElements();
    const el = elements.find((x) => x.id === this.lastSelectedId);
    if (!el) {
      this.propertiesPanelEl.classList.add("is-hidden");
      return;
    }

    this.propertiesPanelEl.classList.remove("is-hidden");

    const typeLabels: Record<CanvasElement["type"], string> = {
      image: "🖼 Картинка",
      rect: "⬜ Прямоугольник",
      arrow: "↗️ Стрелка",
      text: "T Текст / Ссылка",
    };

    const header = this.propertiesPanelEl.createDiv({ cls: "mni-prop-header" });
    header.createEl("h4", {
      text:
        this.selectedElementIds.size > 1
          ? `Выбрано: ${this.selectedElementIds.size}`
          : typeLabels[el.type],
      cls: "mni-prop-title",
    });

    const createSection = (title: string): HTMLElement => {
      const sec = this.propertiesPanelEl.createDiv({ cls: "mni-prop-group" });
      sec.createDiv({ cls: "mni-prop-group-label", text: title });
      return sec;
    };

    const layerGroup = createSection("Слой и действия");
    const layerRow = layerGroup.createDiv({ cls: "mni-prop-row" });
    const frontBtn = layerRow.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "⬆ Вперёд",
      attr: { type: "button", title: "На передний план" },
    });
    frontBtn.onclick = () => this.bringSelectedToFront();

    const backBtn = layerRow.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "⬇ Назад",
      attr: { type: "button", title: "На задний план" },
    });
    backBtn.onclick = () => this.sendSelectedToBack();

    const addColorControl = (
      parent: HTMLElement,
      label: string,
      current: string,
      onChange: (v: string) => void
    ) => {
      const row = parent.createDiv({ cls: "mni-prop-row" });
      row.createSpan({ text: label });

      const rightWrap = row.createDiv({ cls: "mni-prop-color-wrap" });
      const swatches = rightWrap.createDiv({ cls: "mni-prop-swatches" });
      QUICK_COLORS.forEach((swatchColor) => {
        const sBtn = swatches.createEl("button", {
          cls: "mni-swatch-btn",
          attr: { type: "button", title: swatchColor },
        });
        sBtn.style.backgroundColor = swatchColor;
        sBtn.onclick = () => {
          input.value = swatchColor;
          onChange(swatchColor);
          this.commitHistory();
        };
      });

      const input = rightWrap.createEl("input", { type: "color" });
      input.value = current.startsWith("#") ? current : "#e5a158";
      input.oninput = (e) => onChange((e.target as HTMLInputElement).value);
      input.onchange = () => this.commitHistory();
    };

    const addRangeControl = (
      parent: HTMLElement,
      label: string,
      min: number,
      max: number,
      current: number,
      unit: string,
      onChange: (v: number) => void
    ) => {
      const row = parent.createDiv({ cls: "mni-prop-row is-column" });
      const top = row.createDiv({ cls: "mni-prop-row-head" });
      top.createSpan({ text: label });
      const valBadge = top.createSpan({
        cls: "mni-prop-val-badge",
        text: `${Math.round(current)}${unit}`,
      });

      const input = row.createEl("input", {
        type: "range",
        attr: { min: String(min), max: String(max) },
      });
      input.value = String(Math.round(current));
      input.oninput = (e) => {
        const num = Number((e.target as HTMLInputElement).value);
        valBadge.setText(`${Math.round(num)}${unit}`);
        onChange(num);
      };
      input.onchange = () => this.commitHistory();
    };

    const addSelectControl = <T extends string>(
      parent: HTMLElement,
      label: string,
      current: T,
      options: { val: T; lbl: string }[],
      onChange: (v: T) => void
    ) => {
      const row = parent.createDiv({ cls: "mni-prop-row" });
      row.createSpan({ text: label });
      const select = row.createEl("select", { cls: "mni-prop-select" });
      options.forEach((opt) => {
        const o = select.createEl("option", { text: opt.lbl, value: opt.val });
        if (opt.val === current) o.selected = true;
      });
      select.onchange = (e) => {
        onChange((e.target as HTMLSelectElement).value as T);
        this.commitHistory();
      };
    };

    const targetSet = new Set([el.id]);

    if (el.type === "rect") {
      const styleGroup = createSection("Оформление");
      addColorControl(styleGroup, "Обводка", el.stroke, (val) => {
        el.stroke = val;
        this.renderer.updateElementsIncremental(
          elements,
          targetSet,
          this.selectedElementIds
        );
      });
      addColorControl(
        styleGroup,
        "Заливка",
        el.fill.startsWith("#") ? el.fill : "#000000",
        (val) => {
          el.fill = val;
          this.renderer.updateElementsIncremental(
            elements,
            targetSet,
            this.selectedElementIds
          );
        }
      );

      const geomGroup = createSection("Геометрия");
      addRangeControl(geomGroup, "Толщина", 1, 12, el.strokeWidth, " px", (val) => {
        el.strokeWidth = val;
        this.renderer.updateElementsIncremental(
          elements,
          targetSet,
          this.selectedElementIds
        );
      });
      addRangeControl(
        geomGroup,
        "Скругление",
        0,
        50,
        el.borderRadius ?? 0,
        " px",
        (val) => {
          el.borderRadius = val;
          this.renderer.updateElementsIncremental(
            elements,
            targetSet,
            this.selectedElementIds
          );
        }
      );
    } else if (el.type === "arrow") {
      const styleGroup = createSection("Линия");
      addColorControl(styleGroup, "Цвет", el.stroke, (val) => {
        el.stroke = val;
        this.renderer.updateElementsIncremental(
          elements,
          targetSet,
          this.selectedElementIds
        );
      });
      addRangeControl(styleGroup, "Толщина", 1, 10, el.strokeWidth, " px", (val) => {
        el.strokeWidth = val;
        this.renderer.updateElementsIncremental(
          elements,
          targetSet,
          this.selectedElementIds
        );
      });

      const routeGroup = createSection("Маршрут");
      addSelectControl<ArrowRouting>(
        routeGroup,
        "Тип",
        el.routing,
        [
          { val: "straight", lbl: "Прямая" },
          { val: "curved", lbl: "Кривая Безье" },
          { val: "orthogonal", lbl: "Ортогональная" },
        ],
        (val) => {
          el.routing = val;
          if (val === "curved") {
            const pts = CanvasEngine.getArrowControlPoints(el);
            el.cx1 = pts.cx1;
            el.cy1 = pts.cy1;
            el.cx2 = pts.cx2;
            el.cy2 = pts.cy2;
          }
          this.renderer.updateElementsIncremental(
            elements,
            targetSet,
            this.selectedElementIds
          );
        }
      );

      addSelectControl<ArrowHead>(
        routeGroup,
        "Начало",
        el.startHead || "none",
        [
          { val: "none", lbl: "Нет" },
          { val: "arrow", lbl: "Стрелка" },
        ],
        (val) => {
          el.startHead = val;
          this.renderer.updateElementsIncremental(
            elements,
            targetSet,
            this.selectedElementIds
          );
        }
      );

      addSelectControl<ArrowHead>(
        routeGroup,
        "Конец",
        el.endHead || "arrow",
        [
          { val: "none", lbl: "Нет" },
          { val: "arrow", lbl: "Стрелка" },
        ],
        (val) => {
          el.endHead = val;
          this.renderer.updateElementsIncremental(
            elements,
            targetSet,
            this.selectedElementIds
          );
        }
      );
    } else if (el.type === "text") {
      const textGroup = createSection("Типографика");
      addColorControl(textGroup, "Цвет", el.color, (val) => {
        el.color = val;
        this.renderer.updateElementsIncremental(
          elements,
          targetSet,
          this.selectedElementIds
        );
      });
      addRangeControl(textGroup, "Шрифт", 10, 72, el.fontSize, " px", (val) => {
        el.fontSize = val;
        this.renderer.updateElementsIncremental(
          elements,
          targetSet,
          this.selectedElementIds
        );
      });
    }
  }

  public fitToScreen(): void {
    const rect = this.viewportEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.lastViewportW = Math.round(rect.width);
    this.lastViewportH = Math.round(rect.height);

    const list = this.getCurrentElements();
    const pad = 36;

    if (list.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const el of list) {
        const b = CanvasEngine.getElementBBox(el);
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      }

      const contentW = Math.max(160, maxX - minX);
      const contentH = Math.max(120, maxY - minY);
      const availW = Math.max(100, rect.width - pad * 2);
      const availH = Math.max(100, rect.height - pad * 2);
      const fitScale = Math.min(availW / contentW, availH / contentH, 1.4);

      this.scale = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, Number(fitScale.toFixed(3)))
      );
      this.panX = Math.round(
        (rect.width - contentW * this.scale) / 2 - minX * this.scale
      );
      this.panY = Math.round(
        (rect.height - contentH * this.scale) / 2 - minY * this.scale
      );
      this.applyTransform();
      return;
    }

    const fit = CanvasEngine.computeFitTransform(
      rect.width,
      rect.height,
      this.naturalW,
      this.naturalH,
      pad
    );
    this.scale = fit.scale;
    this.panX = fit.panX;
    this.panY = fit.panY;
    this.applyTransform();
  }

  private resetZoomTo100(): void {
    const rect = this.viewportEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const factor = 1 / (this.scale > 0.001 ? this.scale : 1);
    this.zoomAtPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      factor
    );
  }

  private zoomByCenter(factor: number): void {
    const rect = this.viewportEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.zoomAtPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      factor
    );
  }

  private applyTransform(): void {
    this.layerEl.style.transform = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.scale})`;
    if (this.zoomResetBtn) {
      this.zoomResetBtn.setText(`${Math.round(this.scale * 100)}%`);
    }
    this.saveCurrentSlideViewportState();
  }

  private bindDragAndDropEvents(target: HTMLElement): void {
    target.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      target.classList.add("is-drag-over");
    });

    target.addEventListener("dragleave", () => {
      target.classList.remove("is-drag-over");
    });

    target.addEventListener("drop", async (e: DragEvent) => {
      e.preventDefault();
      target.classList.remove("is-drag-over");
      if (!this.currentNote || !e.dataTransfer) return;

      const dropCoords = this.getImageCoords(e.clientX, e.clientY);

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (const file of Array.from(e.dataTransfer.files)) {
          const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
          if (file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) {
            const buf = await file.arrayBuffer();
            const savedFile = await saveBinaryImageToVault(
              this.app,
              this.currentNote.file,
              buf,
              file.type || ext,
              this.callbacks.getMediaFolder()
            );
            await this.addImageElementToCurrentCanvas(
              savedFile.path,
              dropCoords
            );
          }
        }
        return;
      }

      const rawText =
        e.dataTransfer.getData("text/plain") ||
        e.dataTransfer.getData("text/uri-list") ||
        "";
      const clean = rawText.trim();
      if (!clean) return;

      if (clean.startsWith("obsidian://")) {
        try {
          const u = new URL(clean);
          const fileParam = u.searchParams.get("file");
          if (fileParam) {
            await this.addImageElementToCurrentCanvas(
              decodeURIComponent(fileParam),
              dropCoords
            );
            return;
          }
        } catch {
          // игнорируем
        }
      }

      if (isExternalImageUrl(clean) || clean.length > 0) {
        await this.addImageElementToCurrentCanvas(clean, dropCoords);
      }
    });
  }

  private bindKeyboardAndPasteEvents(): void {
    this.keyDownHandler = (e: KeyboardEvent) => {
      if (!this.container.isConnected || this.container.hasClass("is-hidden")) {
        return;
      }
      const targetTag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(targetTag)) return;

      if (e.code === "Space" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!this.isSpacePressed) {
          this.isSpacePressed = true;
          this.viewportEl.classList.add("is-space-panning");
        }
        return;
      }

      const key = e.key.toLowerCase();
      if (!e.ctrlKey && !e.metaKey) {
        if (key === "v") this.setTool("select");
        else if (key === "h") this.setTool("pan");
        else if (key === "r") this.setTool("rect");
        else if (key === "a") this.setTool("arrow");
        else if (key === "t") this.setTool("text");
      }

      if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      }

      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        this.selectedElementIds.size > 0
      ) {
        e.preventDefault();
        this.deleteSelected();
      }
    };

    this.keyUpHandler = (e: KeyboardEvent) => {
      if (e.code === "Space" && this.isSpacePressed) {
        this.isSpacePressed = false;
        this.viewportEl?.classList.remove("is-space-panning");
      }
    };

    this.windowBlurHandler = () => {
      if (this.isSpacePressed) {
        this.isSpacePressed = false;
        this.viewportEl?.classList.remove("is-space-panning");
      }
    };

    this.pasteHandler = async (e: ClipboardEvent) => {
      if (!this.container.isConnected || this.container.hasClass("is-hidden")) {
        return;
      }
      const targetTag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA"].includes(targetTag)) return;
      if (!this.currentNote || !e.clipboardData) return;

      for (const item of Array.from(e.clipboardData.items)) {
        if (item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (!blob) continue;
          e.preventDefault();
          const buf = await blob.arrayBuffer();
          const savedFile = await saveBinaryImageToVault(
            this.app,
            this.currentNote.file,
            buf,
            item.type,
            this.callbacks.getMediaFolder()
          );
          new Notice(`Картинка добавлена на текущий холст: ${savedFile.name}`);
          await this.addImageElementToCurrentCanvas(savedFile.path);
          return;
        }
      }
    };

    window.addEventListener("keydown", this.keyDownHandler);
    window.addEventListener("keyup", this.keyUpHandler);
    window.addEventListener("blur", this.windowBlurHandler);
    window.addEventListener("paste", this.pasteHandler);
  }

  private deleteSelected(): void {
    if (this.selectedElementIds.size === 0) return;
    const list = this.getCurrentElements();
    this.setCurrentElements(
      list.filter((el) => !this.selectedElementIds.has(el.id))
    );
    this.selectedElementIds.clear();
    this.lastSelectedId = null;
    this.updateDeleteButton();
    this.updatePropertiesPanel();
    this.renderElements();
    this.commitHistory();
  }

  private cancelActiveSinglePointerInteraction(): void {
    const elements = this.getCurrentElements();

    if (this.isDrawing && this.previewEl) {
      this.previewEl.remove();
      this.previewEl = null;
      this.isDrawing = false;
      this.drawStartSnap = null;
    }

    if (this.isMarquee) {
      this.isMarquee = false;
      if (this.marqueeEl) {
        this.marqueeEl.remove();
        this.marqueeEl = null;
      }
    }

    if (this.isDraggingEl && this.hasExceededDragThreshold) {
      this.groupDragStartPositions.forEach((start, id) => {
        const el = elements.find((x) => x.id === id);
        if (!el) return;
        if (el.type === "arrow" && start.type === "arrow") {
          el.x1 = start.x1;
          el.y1 = start.y1;
          el.x2 = start.x2;
          el.y2 = start.y2;
          if (start.cx1 !== undefined) el.cx1 = start.cx1;
          if (start.cy1 !== undefined) el.cy1 = start.cy1;
          if (start.cx2 !== undefined) el.cx2 = start.cx2;
          if (start.cy2 !== undefined) el.cy2 = start.cy2;
        } else if (el.type !== "arrow" && start.type === "box") {
          el.x = start.x;
          el.y = start.y;
        }
      });
      CanvasEngine.syncArrowsToBlocks(elements);
      this.renderElements();
    }

    if (this.isResizing && this.lastSelectedId) {
      const el = elements.find((x) => x.id === this.lastSelectedId);
      if (el && el.type !== "arrow") {
        el.x = this.resizeStartBBox.x;
        el.y = this.resizeStartBBox.y;
        el.width = this.resizeStartBBox.w;
        el.height = this.resizeStartBBox.h;
        this.renderElements();
      }
    }

    this.isDraggingEl = false;
    this.isResizing = false;
    this.isDraggingHandle = false;
    this.pendingElementId = null;
    this.hasExceededDragThreshold = false;
    this.groupDragStartPositions.clear();
    this.isPanning = false;
    this.viewportEl.classList.remove("is-dragging");
  }

  private bindPointerEvents(target: HTMLElement): void {
    target.addEventListener("dblclick", (e: MouseEvent) => {
      if (this.currentTool === "pan" || this.isSpacePressed) return;
      const clickedTextEl = (e.target as HTMLElement).closest(
        ".mni-el-text"
      ) as HTMLElement | null;
      if (!clickedTextEl) return;
      e.stopPropagation();
      const id = clickedTextEl.dataset.id;
      if (id) {
        this.setTool("select");
        this.spawnTextInput(e.clientX, e.clientY, id);
      }
    });

    target.addEventListener("pointerdown", (e: PointerEvent) => {
      if (
        (e.target as HTMLElement).closest(
          ".mni-toolbar, .mni-properties-panel, .mni-el-input-wrapper, .my-sc-schema-empty-state"
        )
      ) {
        return;
      }

      if (
        this.currentTool === "select" &&
        !this.isSpacePressed &&
        (e.target as HTMLElement).closest("a.internal-link")
      ) {
        return;
      }

      if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // игнорируем, если pointerCapture недоступен
      }

      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.downClientPoint = { x: e.clientX, y: e.clientY };
      this.hasExceededDragThreshold = false;
      this.pendingElementId = null;
      this.pendingShiftKey = e.shiftKey;

      // Два пальца на экране — всегда панорама + масштаб (pinch) в любом режиме
      if (this.activePointers.size >= 2) {
        this.cancelActiveSinglePointerInteraction();
        this.prevPinchDistance = this.getPinchDistance();
        this.prevPinchCenter = this.getPinchCenter();
        return;
      }

      // Принудительная панорама: режим «Панорама», удержание пробела или средняя кнопка мыши
      const isForcedPan =
        this.currentTool === "pan" ||
        this.isSpacePressed ||
        (e.pointerType === "mouse" && e.button === 1);

      if (isForcedPan) {
        this.isPanning = true;
        target.classList.add("is-dragging");
        this.startPanPoint = { x: e.clientX, y: e.clientY };
        this.startTransform = { x: this.panX, y: this.panY };
        return;
      }

      const elements = this.getCurrentElements();
      const svgTarget = e.target as SVGElement;
      const clickedEl = (e.target as HTMLElement).closest(
        ".mni-el, .mni-el-svg"
      ) as HTMLElement | SVGElement | null;

      // В режиме «Выделение» проверяем маркеры масштабирования, маркеры стрелки и клик по объекту
      if (this.currentTool === "select") {
        if (svgTarget.classList.contains("mni-resize-handle")) {
          const handleAttr = svgTarget.dataset.handle as
            | ResizeHandleType
            | undefined;
          const targetId = svgTarget.dataset.id;
          if (!handleAttr || !targetId) return;

          this.isResizing = true;
          this.activeResizeHandle = handleAttr;
          this.selectedElementIds.clear();
          this.selectedElementIds.add(targetId);
          this.lastSelectedId = targetId;

          const el = elements.find((x) => x.id === targetId);
          if (el && el.type !== "arrow") {
            this.resizeStartBBox = {
              x: el.x,
              y: el.y,
              w: el.width,
              h: el.height,
              fontSize: el.type === "text" ? el.fontSize : 16,
              aspectRatio:
                el.type === "image"
                  ? el.aspectRatio || el.width / Math.max(1, el.height)
                  : el.width / Math.max(1, el.height),
            };
            this.dragStartPoint = this.getImageCoords(e.clientX, e.clientY);
          }
          return;
        }

        if (svgTarget.classList.contains("mni-arrow-handle")) {
          const handleAttr = svgTarget.dataset.handle as
            | ArrowHandleType
            | undefined;
          const targetId = svgTarget.dataset.id;
          if (!handleAttr || !targetId) return;

          this.isDraggingHandle = true;
          this.draggedHandleType = handleAttr;
          this.selectedElementIds.clear();
          this.selectedElementIds.add(targetId);
          this.lastSelectedId = targetId;
          return;
        }

        if (clickedEl) {
          const clickedId = clickedEl.dataset.id;
          if (clickedId) {
            this.pendingElementId = clickedId;
            this.isDraggingEl = true;
            this.dragStartPoint = this.getImageCoords(e.clientX, e.clientY);
            return;
          }
        }

        // Пустое место в режиме «Выделение»:
        // Shift + перетаскивание или Apple Pencil -> рамка выделения нескольких объектов;
        // обычное перетаскивание мышью или одним пальцем по пустому месту -> панорама!
        if (e.shiftKey || e.pointerType === "pen") {
          this.isMarquee = true;
          this.marqueeStart = this.getImageCoords(e.clientX, e.clientY);
          if (!e.shiftKey) {
            this.selectedElementIds.clear();
            this.lastSelectedId = null;
          }
          this.updateDeleteButton();
          this.updatePropertiesPanel();
          this.renderer.updateSelectionStates(elements, this.selectedElementIds);

          this.marqueeEl = this.elementsLayerEl.createDiv({
            cls: "mni-marquee",
          });
          this.marqueeEl.style.left = `${this.marqueeStart.x}px`;
          this.marqueeEl.style.top = `${this.marqueeStart.y}px`;
          this.marqueeEl.style.width = "0px";
          this.marqueeEl.style.height = "0px";
          return;
        }

        this.isPanning = true;
        target.classList.add("is-dragging");
        this.startPanPoint = { x: e.clientX, y: e.clientY };
        this.startTransform = { x: this.panX, y: this.panY };
        return;
      }

      // Инструменты рисования «Прямоугольник» и «Стрелка»
      if (this.currentTool === "rect" || this.currentTool === "arrow") {
        // Если на сенсорном экране пользователь ведёт одним пальцем по пустому месту в режиме текста — панорамируем,
        // а в режиме фигур рисуем (при касании двумя пальцами рисование автоматически отменяется и переходит в pinch-pan)
        const coords = this.getImageCoords(e.clientX, e.clientY);
        this.drawStartPoint = coords;
        this.drawStartSnap = null;

        if (this.currentTool === "rect") {
          this.isDrawing = true;
          this.previewEl = this.elementsLayerEl.createDiv({
            cls: "mni-el mni-el-rect is-preview",
          });
          this.previewEl.style.left = `${coords.x}px`;
          this.previewEl.style.top = `${coords.y}px`;
          this.previewEl.style.width = "0px";
          this.previewEl.style.height = "0px";
          this.previewEl.style.borderColor = "#e5a158";
          this.previewEl.style.borderWidth = "2px";
          this.previewEl.style.backgroundColor = "rgba(229, 161, 88, 0.1)";
        } else if (this.currentTool === "arrow") {
          this.isDrawing = true;
          const snap = CanvasEngine.findNearestSnapAnchor(coords, elements);
          if (snap) {
            this.drawStartPoint = { x: snap.x, y: snap.y };
            this.drawStartSnap = { id: snap.id, anchor: snap.anchor };
          }
          const path = document.createElementNS(SVG_NS, "path");
          path.setAttribute(
            "d",
            `M ${this.drawStartPoint.x} ${this.drawStartPoint.y} L ${this.drawStartPoint.x} ${this.drawStartPoint.y}`
          );
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", "#e5a158");
          path.setAttribute("stroke-width", "2");
          path.setAttribute("marker-end", "url(#mni-head-end)");
          path.classList.add("mni-el-svg-preview");
          this.renderer.getArrowsContainer().appendChild(path);
          this.previewEl = path;
        }
        return;
      }

      // В режиме «Текст» перетаскивание по пустому месту панорамирует, а одиночный клик/тап ставит текст
      this.isPanning = true;
      target.classList.add("is-dragging");
      this.startPanPoint = { x: e.clientX, y: e.clientY };
      this.startTransform = { x: this.panX, y: this.panY };
    });

    target.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this.activePointers.has(e.pointerId)) return;

      // Обработка жеста двумя пальцами (одновременная панорама + масштаб вокруг центра щипка)
      if (this.activePointers.size >= 2) {
        const oldCenter = this.prevPinchCenter ?? this.getPinchCenter();
        const oldDist = this.prevPinchDistance ?? this.getPinchDistance();

        this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        const newCenter = this.getPinchCenter();
        const newDist = this.getPinchDistance();

        this.panX += newCenter.x - oldCenter.x;
        this.panY += newCenter.y - oldCenter.y;
        this.userAdjustedViewport = true;

        if (oldDist > 8 && newDist > 8) {
          const factor = newDist / oldDist;
          this.zoomAtPoint(newCenter.x, newCenter.y, factor);
        } else {
          this.applyTransform();
        }

        this.prevPinchCenter = newCenter;
        this.prevPinchDistance = newDist;
        return;
      }

      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      const clientDist = Math.hypot(
        e.clientX - this.downClientPoint.x,
        e.clientY - this.downClientPoint.y
      );
      if (clientDist >= DRAG_THRESHOLD_PX) {
        this.hasExceededDragThreshold = true;
      }

      const elements = this.getCurrentElements();

      if (this.isResizing && this.lastSelectedId && this.activeResizeHandle) {
        const el = elements.find((x) => x.id === this.lastSelectedId);
        if (!el || el.type === "arrow") return;

        const current = this.getImageCoords(e.clientX, e.clientY);
        const dx = current.x - this.dragStartPoint.x;
        const dy = current.y - this.dragStartPoint.y;

        const lockAspect = el.type === "image";
        const nextGeom = CanvasEngine.computeResizedGeometry(
          this.resizeStartBBox,
          this.activeResizeHandle,
          dx,
          dy,
          lockAspect
        );

        el.x = nextGeom.x;
        el.y = nextGeom.y;
        el.width = nextGeom.width;
        el.height = nextGeom.height;

        const dirtyIds = CanvasEngine.syncArrowsToBlocks(elements);
        dirtyIds.add(el.id);
        this.renderer.updateElementsIncremental(
          elements,
          dirtyIds,
          this.selectedElementIds
        );
        return;
      }

      if (this.isMarquee && this.marqueeEl) {
        const current = this.getImageCoords(e.clientX, e.clientY);
        const x = Math.min(this.marqueeStart.x, current.x);
        const y = Math.min(this.marqueeStart.y, current.y);
        const width = Math.abs(this.marqueeStart.x - current.x);
        const height = Math.abs(this.marqueeStart.y - current.y);

        this.marqueeEl.style.left = `${x}px`;
        this.marqueeEl.style.top = `${y}px`;
        this.marqueeEl.style.width = `${width}px`;
        this.marqueeEl.style.height = `${height}px`;

        const marqueeBox = { x, y, width, height };
        this.selectedElementIds.clear();
        for (const el of elements) {
          const bbox = CanvasEngine.getElementBBox(el);
          if (CanvasEngine.boxesIntersect(marqueeBox, bbox)) {
            this.selectedElementIds.add(el.id);
          }
        }
        this.lastSelectedId =
          this.selectedElementIds.size > 0
            ? (Array.from(this.selectedElementIds)[0] ?? null)
            : null;
        this.updateDeleteButton();
        this.renderer.updateSelectionStates(elements, this.selectedElementIds);
        return;
      }

      if (
        this.isDraggingHandle &&
        this.lastSelectedId &&
        this.draggedHandleType
      ) {
        const el = elements.find((x) => x.id === this.lastSelectedId);
        if (el && el.type === "arrow") {
          const current = this.getImageCoords(e.clientX, e.clientY);

          if (this.draggedHandleType === "start") {
            const snap = CanvasEngine.findNearestSnapAnchor(current, elements);
            if (snap) {
              el.x1 = snap.x;
              el.y1 = snap.y;
              el.startElementId = snap.id;
              el.startAnchor = snap.anchor;
              this.renderer.showSnapIndicator({ x: snap.x, y: snap.y });
            } else {
              el.x1 = current.x;
              el.y1 = current.y;
              el.startElementId = undefined;
              el.startAnchor = undefined;
              this.renderer.showSnapIndicator(null);
            }
          } else if (this.draggedHandleType === "end") {
            const snap = CanvasEngine.findNearestSnapAnchor(current, elements);
            if (snap) {
              el.x2 = snap.x;
              el.y2 = snap.y;
              el.endElementId = snap.id;
              el.endAnchor = snap.anchor;
              this.renderer.showSnapIndicator({ x: snap.x, y: snap.y });
            } else {
              el.x2 = current.x;
              el.y2 = current.y;
              el.endElementId = undefined;
              el.endAnchor = undefined;
              this.renderer.showSnapIndicator(null);
            }
          } else if (this.draggedHandleType === "curve1") {
            el.cx1 = current.x;
            el.cy1 = current.y;
          } else if (this.draggedHandleType === "curve2") {
            el.cx2 = current.x;
            el.cy2 = current.y;
          }

          this.renderer.updateElementsIncremental(
            elements,
            new Set([el.id]),
            this.selectedElementIds
          );
        }
        return;
      }

      // Перемещение объектов начинается ТОЛЬКО после преодоления порога смещения DRAG_THRESHOLD_PX (5 px)
      if (this.isDraggingEl) {
        if (!this.hasExceededDragThreshold) {
          return;
        }

        if (this.groupDragStartPositions.size === 0 && this.pendingElementId) {
          const clickedId = this.pendingElementId;
          if (!this.selectedElementIds.has(clickedId)) {
            if (!this.pendingShiftKey) {
              this.selectedElementIds.clear();
            }
            this.selectedElementIds.add(clickedId);
          }
          this.lastSelectedId =
            Array.from(this.selectedElementIds).pop() ?? null;
          this.updateDeleteButton();
          this.updatePropertiesPanel();
          this.renderer.updateSelectionStates(
            elements,
            this.selectedElementIds
          );

          this.selectedElementIds.forEach((id) => {
            const el = elements.find((x) => x.id === id);
            if (!el) return;
            if (el.type === "arrow") {
              const ctrl = CanvasEngine.getArrowControlPoints(el);
              this.groupDragStartPositions.set(id, {
                type: "arrow",
                x1: el.x1,
                y1: el.y1,
                x2: el.x2,
                y2: el.y2,
                cx1: el.cx1 !== undefined ? ctrl.cx1 : undefined,
                cy1: el.cy1 !== undefined ? ctrl.cy1 : undefined,
                cx2: el.cx2 !== undefined ? ctrl.cx2 : undefined,
                cy2: el.cy2 !== undefined ? ctrl.cy2 : undefined,
              });
            } else {
              this.groupDragStartPositions.set(id, {
                type: "box",
                x: el.x,
                y: el.y,
              });
            }
          });
        }

        const current = this.getImageCoords(e.clientX, e.clientY);
        const dx = current.x - this.dragStartPoint.x;
        const dy = current.y - this.dragStartPoint.y;
        const dirtyIds = new Set<string>();

        this.selectedElementIds.forEach((id) => {
          const el = elements.find((x) => x.id === id);
          const start = this.groupDragStartPositions.get(id);
          if (!el || !start) return;

          if (el.type === "arrow" && start.type === "arrow") {
            el.x1 = Math.round(start.x1 + dx);
            el.y1 = Math.round(start.y1 + dy);
            el.x2 = Math.round(start.x2 + dx);
            el.y2 = Math.round(start.y2 + dy);
            if (start.cx1 !== undefined && start.cy1 !== undefined) {
              el.cx1 = Math.round(start.cx1 + dx);
              el.cy1 = Math.round(start.cy1 + dy);
            }
            if (start.cx2 !== undefined && start.cy2 !== undefined) {
              el.cx2 = Math.round(start.cx2 + dx);
              el.cy2 = Math.round(start.cy2 + dy);
            }
            dirtyIds.add(el.id);
          } else if (el.type !== "arrow" && start.type === "box") {
            el.x = Math.round(start.x + dx);
            el.y = Math.round(start.y + dy);
            dirtyIds.add(el.id);
          }
        });

        const syncedArrows = CanvasEngine.syncArrowsToBlocks(elements);
        for (const arrowId of syncedArrows) dirtyIds.add(arrowId);

        this.renderer.updateElementsIncremental(
          elements,
          dirtyIds,
          this.selectedElementIds
        );
        return;
      }

      if (this.isDrawing && this.previewEl) {
        const current = this.getImageCoords(e.clientX, e.clientY);

        if (this.currentTool === "rect") {
          const width = Math.abs(current.x - this.drawStartPoint.x);
          const height = Math.abs(current.y - this.drawStartPoint.y);
          const left = Math.min(current.x, this.drawStartPoint.x);
          const top = Math.min(current.y, this.drawStartPoint.y);
          const box = this.previewEl as HTMLElement;
          box.style.left = `${left}px`;
          box.style.top = `${top}px`;
          box.style.width = `${width}px`;
          box.style.height = `${height}px`;
        } else if (this.currentTool === "arrow") {
          const snap = CanvasEngine.findNearestSnapAnchor(current, elements);
          const endX = snap ? snap.x : current.x;
          const endY = snap ? snap.y : current.y;
          this.renderer.showSnapIndicator(
            snap ? { x: snap.x, y: snap.y } : null
          );
          const path = this.previewEl as SVGPathElement;
          path.setAttribute(
            "d",
            `M ${this.drawStartPoint.x} ${this.drawStartPoint.y} L ${endX} ${endY}`
          );
        }
        return;
      }

      if (this.isPanning && this.activePointers.size === 1) {
        const moveDx = e.clientX - this.startPanPoint.x;
        const moveDy = e.clientY - this.startPanPoint.y;
        this.panX = this.startTransform.x + moveDx;
        this.panY = this.startTransform.y + moveDy;
        this.userAdjustedViewport = true;
        this.applyTransform();
      }
    });

    const onPointerEnd = (e: PointerEvent) => {
      if (!this.activePointers.has(e.pointerId)) return;
      this.activePointers.delete(e.pointerId);
      this.renderer.showSnapIndicator(null);

      if (this.activePointers.size === 1) {
        const remaining = Array.from(this.activePointers.values())[0];
        if (remaining) {
          this.prevPinchDistance = null;
          this.prevPinchCenter = null;
          this.isPanning = true;
          this.startPanPoint = { x: remaining.x, y: remaining.y };
          this.startTransform = { x: this.panX, y: this.panY };
        }
        return;
      }

      if (this.activePointers.size > 1) {
        this.prevPinchDistance = this.getPinchDistance();
        this.prevPinchCenter = this.getPinchCenter();
        return;
      }

      this.prevPinchDistance = null;
      this.prevPinchCenter = null;

      const elements = this.getCurrentElements();

      if (this.isResizing) {
        this.isResizing = false;
        this.activeResizeHandle = null;
        this.syncBoardSurfaceBounds();
        this.updatePropertiesPanel();
        this.commitHistory();
        return;
      }

      if (this.isMarquee) {
        this.isMarquee = false;
        if (this.marqueeEl) {
          this.marqueeEl.remove();
          this.marqueeEl = null;
        }
        this.updatePropertiesPanel();
        this.updateDeleteButton();
        this.renderer.updateSelectionStates(
          elements,
          this.selectedElementIds
        );
        return;
      }

      if (this.isDraggingHandle) {
        this.isDraggingHandle = false;
        this.draggedHandleType = null;
        this.commitHistory();
        return;
      }

      if (this.isDraggingEl) {
        const clickedId = this.pendingElementId;
        const wasDragged = this.hasExceededDragThreshold;

        this.isDraggingEl = false;
        this.pendingElementId = null;
        this.groupDragStartPositions.clear();

        if (wasDragged) {
          this.syncBoardSurfaceBounds();
          this.commitHistory();
          return;
        }

        // Одиночный клик/тап без смещения (< 5 px) в режиме «Выделение» просто выбирает объект
        if (clickedId && this.currentTool === "select") {
          if (this.pendingShiftKey) {
            if (
              this.selectedElementIds.has(clickedId) &&
              this.selectedElementIds.size > 1
            ) {
              this.selectedElementIds.delete(clickedId);
            } else {
              this.selectedElementIds.add(clickedId);
            }
          } else {
            this.selectedElementIds.clear();
            this.selectedElementIds.add(clickedId);
          }
          this.lastSelectedId =
            Array.from(this.selectedElementIds).pop() ?? null;
          this.updateDeleteButton();
          this.updatePropertiesPanel();
          this.renderer.updateSelectionStates(
            elements,
            this.selectedElementIds
          );

          // Проверка двойного тапа по текстовому элементу для редактирования
          const tappedTextEl = (e.target as HTMLElement | null)?.closest(
            ".mni-el-text"
          ) as HTMLElement | null;
          const tappedId = tappedTextEl?.dataset.id ?? null;
          const now = Date.now();
          if (
            tappedId &&
            this.lastTapTextId === tappedId &&
            now - this.lastTapTextAt < DOUBLE_TAP_MS
          ) {
            this.lastTapTextId = null;
            this.spawnTextInput(e.clientX, e.clientY, tappedId);
            return;
          }
          this.lastTapTextId = tappedId;
          this.lastTapTextAt = now;
        }
        return;
      }

      if (this.isDrawing && this.previewEl) {
        this.isDrawing = false;
        const current = this.getImageCoords(e.clientX, e.clientY);
        const list = this.getCurrentElements();
        let createdId: string | null = null;

        if (this.currentTool === "rect") {
          const width = Math.abs(current.x - this.drawStartPoint.x);
          const height = Math.abs(current.y - this.drawStartPoint.y);
          const left = Math.min(current.x, this.drawStartPoint.x);
          const top = Math.min(current.y, this.drawStartPoint.y);
          if (width > 10 && height > 10) {
            const newRect: RectElement = {
              id: `rect_${Date.now()}`,
              type: "rect",
              x: Math.round(left),
              y: Math.round(top),
              width: Math.round(width),
              height: Math.round(height),
              stroke: "#e5a158",
              strokeWidth: 2,
              fill: "rgba(229, 161, 88, 0.1)",
              borderRadius: 4,
            };
            list.push(newRect);
            createdId = newRect.id;
            this.setCurrentElements(list);
          }
        } else if (this.currentTool === "arrow") {
          const dist = Math.hypot(
            current.x - this.drawStartPoint.x,
            current.y - this.drawStartPoint.y
          );
          if (dist > 10) {
            const endSnap = CanvasEngine.findNearestSnapAnchor(current, list);
            const finalX = endSnap ? endSnap.x : current.x;
            const finalY = endSnap ? endSnap.y : current.y;

            const newArrow: ArrowElement = {
              id: `arrow_${Date.now()}`,
              type: "arrow",
              x1: Math.round(this.drawStartPoint.x),
              y1: Math.round(this.drawStartPoint.y),
              x2: Math.round(finalX),
              y2: Math.round(finalY),
              routing: "straight",
              startHead: "none",
              endHead: "arrow",
              startElementId: this.drawStartSnap?.id,
              startAnchor: this.drawStartSnap?.anchor,
              endElementId: endSnap?.id,
              endAnchor: endSnap?.anchor,
              stroke: "#e5a158",
              strokeWidth: 2,
            };
            list.push(newArrow);
            createdId = newArrow.id;
            this.setCurrentElements(list);
          }
        }

        this.previewEl.remove();
        this.previewEl = null;
        this.drawStartSnap = null;

        if (createdId) {
          this.syncBoardSurfaceBounds();
          this.setTool("select");
          this.selectedElementIds.clear();
          this.selectedElementIds.add(createdId);
          this.lastSelectedId = createdId;
          this.updateDeleteButton();
          this.updatePropertiesPanel();
          this.commitHistory();
        }
        this.renderElements(createdId);
        return;
      }

      if (this.isPanning) {
        this.isPanning = false;
        target.classList.remove("is-dragging");

        // Если это был клик/тап без перетаскивания (< 5 px) по пустому месту:
        if (!this.hasExceededDragThreshold && e.type === "pointerup") {
          if (this.currentTool === "text" && !this.isSpacePressed) {
            this.spawnTextInput(e.clientX, e.clientY);
          } else if (
            this.currentTool === "select" &&
            !this.isSpacePressed &&
            !this.pendingShiftKey &&
            this.selectedElementIds.size > 0
          ) {
            this.selectedElementIds.clear();
            this.lastSelectedId = null;
            this.updateDeleteButton();
            this.updatePropertiesPanel();
            this.renderer.updateSelectionStates(
              elements,
              this.selectedElementIds
            );
          }
        }
      }
    };

    target.addEventListener("pointerup", onPointerEnd);
    target.addEventListener("pointercancel", onPointerEnd);
    target.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // Ctrl + колесо или жест щипка на тачпаде -> плавный зум вокруг курсора
        if (e.ctrlKey || e.metaKey) {
          const dy = Math.max(-120, Math.min(120, e.deltaY));
          const factor = Math.exp(-dy * 0.005);
          this.zoomAtPoint(e.clientX, e.clientY, factor);
          return;
        }

        // Обычная прокрутка колеса / тачпада -> панорамирование холста
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        this.panX -= dx;
        this.panY -= dy;
        this.userAdjustedViewport = true;
        this.applyTransform();
      },
      { passive: false }
    );
  }

  private spawnTextInput(
    clientX: number,
    clientY: number,
    editElementId?: string
  ): void {
    const list = this.getCurrentElements();

    let initialText = "";
    let coords = this.getImageCoords(clientX, clientY);
    let initialFontSize = 16;
    let initialWidth = 240;

    if (editElementId) {
      const existing = list.find((el) => el.id === editElementId);
      if (existing && existing.type === "text") {
        initialText = existing.text;
        coords = { x: existing.x, y: existing.y };
        initialFontSize = existing.fontSize;
        initialWidth = existing.width;
      }
    }

    const wrapper = this.elementsLayerEl.createDiv({
      cls: "mni-el-input-wrapper",
    });
    wrapper.style.left = `${Math.round(coords.x)}px`;
    wrapper.style.top = `${Math.round(coords.y)}px`;
    wrapper.style.width = `${Math.round(initialWidth)}px`;

    const textarea = wrapper.createEl("textarea", {
      cls: "mni-text-input",
      attr: {
        placeholder: "Текст или [[Название дочернего термина]]…",
      },
    });
    textarea.value = initialText;
    textarea.style.fontSize = `${initialFontSize}px`;
    textarea.focus();

    const syncHeight = () => {
      textarea.style.height = "auto";
      const nextH = Math.max(42, textarea.scrollHeight);
      textarea.style.height = `${nextH}px`;
      wrapper.style.height = `${nextH}px`;
    };

    textarea.addEventListener("input", syncHeight);
    if (initialText) syncHeight();

    let finished = false;
    let cancelled = false;

    const finishEditing = () => {
      if (finished) return;
      finished = true;

      const text = textarea.value.trim();
      const finalWidth = Math.max(60, wrapper.offsetWidth || initialWidth);
      const finalHeight = Math.max(34, wrapper.offsetHeight || 42);
      wrapper.remove();

      if (cancelled) {
        this.renderElements();
        return;
      }

      if (!text) {
        if (editElementId) {
          this.selectedElementIds.clear();
          this.selectedElementIds.add(editElementId);
          this.deleteSelected();
        }
        return;
      }

      let targetId: string | null = null;
      if (editElementId) {
        const existing = list.find((el) => el.id === editElementId);
        if (existing && existing.type === "text") {
          existing.text = text;
          existing.width = Math.max(existing.width, finalWidth);
          existing.height = Math.max(existing.height, finalHeight);
          targetId = existing.id;
        }
      } else {
        const newText: TextElement = {
          id: `text_${Date.now()}`,
          type: "text",
          x: Math.round(coords.x),
          y: Math.round(coords.y),
          width: finalWidth,
          height: finalHeight,
          text,
          fontSize: initialFontSize,
          color: "#ffffff",
        };
        list.push(newText);
        targetId = newText.id;
      }

      this.setCurrentElements(list);
      this.syncBoardSurfaceBounds();
      this.setTool("select");
      if (targetId) {
        this.selectedElementIds.clear();
        this.selectedElementIds.add(targetId);
        this.lastSelectedId = targetId;
      }
      this.updateDeleteButton();
      this.updatePropertiesPanel();
      this.commitHistory();
      this.renderElements(targetId);
    };

    textarea.addEventListener("blur", finishEditing);
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        textarea.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelled = true;
        textarea.blur();
      }
    });
  }

  private getImageCoords(clientX: number, clientY: number): Point {
    const viewportRect = this.viewportEl.getBoundingClientRect();
    return CanvasEngine.screenToCanvas(
      clientX,
      clientY,
      viewportRect,
      this.panX,
      this.panY,
      this.scale
    );
  }

  private zoomAtPoint(clientX: number, clientY: number, factor: number): void {
    const viewportRect = this.viewportEl.getBoundingClientRect();
    const next = CanvasEngine.computeZoomAtPoint(
      clientX,
      clientY,
      viewportRect,
      this.scale,
      this.panX,
      this.panY,
      factor
    );
    this.scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next.scale));
    this.panX = next.panX;
    this.panY = next.panY;
    this.userAdjustedViewport = true;
    this.applyTransform();
  }

  private getPinchDistance(): number {
    const pts = Array.from(this.activePointers.values());
    const p0 = pts[0];
    const p1 = pts[1];
    if (!p0 || !p1) return 0;
    return Math.hypot(p0.x - p1.x, p0.y - p1.y);
  }

  private getPinchCenter(): Point {
    const pts = Array.from(this.activePointers.values());
    const p0 = pts[0];
    const p1 = pts[1];
    if (!p0 || !p1) return { x: 0, y: 0 };
    return { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  }

  public destroy(): void {
    this.saveCurrentSlideViewportState();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.keyDownHandler) {
      window.removeEventListener("keydown", this.keyDownHandler);
      this.keyDownHandler = undefined;
    }
    if (this.keyUpHandler) {
      window.removeEventListener("keyup", this.keyUpHandler);
      this.keyUpHandler = undefined;
    }
    if (this.windowBlurHandler) {
      window.removeEventListener("blur", this.windowBlurHandler);
      this.windowBlurHandler = undefined;
    }
    if (this.pasteHandler) {
      window.removeEventListener("paste", this.pasteHandler);
      this.pasteHandler = undefined;
    }
    this.renderer?.destroy();
    void this.manager?.flushSave(this.boardsMap);
    this.container.empty();
  }
}