import { App, FuzzySuggestModal, Notice, TFile, setIcon } from "obsidian";
import {
  AnchorType,
  ArrowElement,
  ArrowHandleType,
  ArrowHead,
  ArrowRouting,
  CanvasElement,
  ElementDragSnapshot,
  Point,
  RectElement,
  ResizeHandleType,
  ResizeSnapshot,
  StudyMediaItem,
  StudyNoteItem,
  TextElement,
  ToolType,
} from "./types";
import { AnnotationManager } from "./pin-manager";
import { CanvasEngine } from "./canvas-engine";
import { CanvasRenderer } from "./canvas-renderer";
import {
  IMAGE_EXTENSIONS,
  VIRTUAL_BOARD_KEY,
  attachImageToNote,
  extractMediaAndAnnotationMeta,
  saveClipboardImageAndAttach,
} from "./media";
import { ScanResult, flattenVisibleTree, buildNestedFilteredTree } from "./scanner";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_BOARD_W = 1280;
const DEFAULT_BOARD_H = 800;
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
    this.setPlaceholder("Выбери картинку или схему из хранилища…");
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

  private activePointers: Map<number, Point> = new Map();
  private prevPinchDistance: number | null = null;
  private isPanning = false;
  private startPanPoint: Point = { x: 0, y: 0 };
  private startTransform: Point = { x: 0, y: 0 };

  private currentTool: ToolType = "pan";
  private elementsByMediaKey: Map<string, CanvasElement[]> = new Map();
  private selectedElementIds: Set<string> = new Set();
  private lastSelectedId: string | null = null;

  private isDrawing = false;
  private drawStartPoint: Point = { x: 0, y: 0 };
  private drawStartSnap: { id: string; anchor: AnchorType } | null = null;
  private previewEl: HTMLElement | SVGPathElement | null = null;

  private isMarquee = false;
  private marqueeStart: Point = { x: 0, y: 0 };
  private marqueeEl: HTMLElement | null = null;

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
  };

  private dragStartPoint: Point = { x: 0, y: 0 };
  private groupDragStartPositions: Map<string, ElementDragSnapshot> = new Map();

  private history: string[] = [];
  private historyIndex = -1;
  private readonly MAX_HISTORY = 40;

  private headerBarEl!: HTMLElement;
  private noteSelectEl!: HTMLSelectElement;
  private slidesBarEl!: HTMLElement;
  private urlDrawerEl!: HTMLElement;
  private stageWrapEl!: HTMLElement;
  private viewportEl!: HTMLElement;
  private layerEl!: HTMLElement;
  private boardBgEl!: HTMLElement;
  private imgEl!: HTMLImageElement;
  private svgLayerEl!: SVGSVGElement;
  private elementsLayerEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private propertiesPanelEl!: HTMLElement;
  private deleteBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;

  private keyHandler?: (e: KeyboardEvent) => void;
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

    // Верхняя панель: выбор узла проекта + прикрепление медиа + Undo/Redo/Fit
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

    const rightControls = this.headerBarEl.createDiv("my-sc-schema-header-right");

    const attachVaultBtn = rightControls.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "🖼 Из хранилища",
      attr: { type: "button", title: "Прикрепить существующую картинку из хранилища к этой заметке" },
    });
    attachVaultBtn.onclick = () => {
      if (!this.currentNote) return;
      new VaultImagePickerModal(this.app, async (pickedFile) => {
        if (!this.currentNote) return;
        await attachImageToNote(this.app, this.currentNote.file, {
          type: "vault",
          imageFile: pickedFile,
        });
        new Notice(`Прикреплено: ${pickedFile.name}`);
        await this.reloadCurrentNoteMedia(pickedFile.name);
      }).open();
    };

    const attachUrlBtn = rightControls.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "🌐 URL",
      attr: { type: "button", title: "Прикрепить изображение из интернета по прямой ссылке" },
    });
    attachUrlBtn.onclick = () => {
      this.urlDrawerEl.toggleClass(
        "is-hidden",
        !this.urlDrawerEl.hasClass("is-hidden")
      );
    };

    this.undoBtn = rightControls.createEl("button", {
      cls: "my-sc-icon-btn",
      attr: { type: "button", title: "Отменить (Ctrl+Z)" },
    });
    setIcon(this.undoBtn, "undo-2");
    this.undoBtn.onclick = () => this.undo();

    this.redoBtn = rightControls.createEl("button", {
      cls: "my-sc-icon-btn",
      attr: { type: "button", title: "Повторить (Ctrl+Shift+Z)" },
    });
    setIcon(this.redoBtn, "redo-2");
    this.redoBtn.onclick = () => this.redo();

    const fitBtn = rightControls.createEl("button", {
      cls: "my-sc-icon-btn",
      attr: { type: "button", title: "Вписать схему в окно" },
    });
    setIcon(fitBtn, "maximize");
    fitBtn.onclick = () => this.fitToScreen();

    // Выдвижная строка ввода внешнего URL
    this.urlDrawerEl = this.container.createDiv("my-sc-schema-url-bar is-hidden");
    const urlInput = this.urlDrawerEl.createEl("input", {
      cls: "my-sc-input",
      attr: {
        type: "url",
        placeholder: "Вставь прямую ссылку на картинку (https://...) или нажми Ctrl+V на холсте…",
      },
    });
    const urlAddBtn = this.urlDrawerEl.createEl("button", {
      cls: "mod-cta my-sc-chip-btn",
      text: "Прикрепить URL",
      attr: { type: "button" },
    });
    urlAddBtn.onclick = async () => {
      const rawUrl = urlInput.value.trim();
      if (!rawUrl || !this.currentNote) return;
      await attachImageToNote(this.app, this.currentNote.file, {
        type: "url",
        url: rawUrl,
      });
      urlInput.value = "";
      this.urlDrawerEl.addClass("is-hidden");
      new Notice("Изображение по ссылке прикреплено к заметке.");
      await this.reloadCurrentNoteMedia(rawUrl);
    };

    // Рабочая область холста
    this.stageWrapEl = this.container.createDiv("mni-container my-sc-schema-stage");
    this.viewportEl = this.stageWrapEl.createDiv({ cls: "mni-viewport" });
    this.layerEl = this.viewportEl.createDiv({ cls: "mni-canvas-layer" });

    this.boardBgEl = this.layerEl.createDiv({ cls: "my-sc-board-surface is-hidden" });
    this.imgEl = this.layerEl.createEl("img", { cls: "mni-image" });
    this.svgLayerEl = document.createElementNS(SVG_NS, "svg");
    this.svgLayerEl.classList.add("mni-svg-layer");
    this.layerEl.appendChild(this.svgLayerEl);
    this.elementsLayerEl = this.layerEl.createDiv({
      cls: "mni-elements-layer",
    });

    this.renderer = new CanvasRenderer(
      this.elementsLayerEl,
      this.svgLayerEl,
      "",
      (linkHref, newLeaf) => this.handleInternalWikiLink(linkHref, newLeaf)
    );

    this.renderToolbar(this.stageWrapEl);
    this.propertiesPanelEl = this.stageWrapEl.createDiv({
      cls: "mni-properties-panel is-hidden",
    });

    this.bindPointerEvents(this.viewportEl);
    this.bindKeyboardAndPasteEvents();
    this.setTool("pan");
  }

  public async update(
    scan: ScanResult,
    projectRoot: StudyNoteItem,
    targetNote: StudyNoteItem
  ): Promise<void> {
    const noteChanged = this.currentNote?.path !== targetNote.path;
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

  private async reloadCurrentNoteMedia(preferKey?: string): Promise<void> {
    if (!this.currentNote || !this.manager) return;

    const { mediaItems } = extractMediaAndAnnotationMeta(
      this.app,
      this.currentNote.file
    );

    const hasBoard = mediaItems.some((m) => m.key === VIRTUAL_BOARD_KEY);
    this.slides = [...mediaItems];
    if (!hasBoard) {
      this.slides.push({
        key: VIRTUAL_BOARD_KEY,
        label: "Чистый холст",
        src: "",
        kind: "board",
      });
    }

    if (preferKey) {
      const idx = this.slides.findIndex((s) => s.key === preferKey);
      this.activeSlideIndex = idx >= 0 ? idx : 0;
    } else {
      this.activeSlideIndex = 0;
    }

    this.selectedElementIds.clear();
    this.lastSelectedId = null;
    this.renderSlidesChips();
    await this.loadActiveSlide();
  }

  private renderSlidesChips(): void {
    this.slidesBarEl.empty();
    this.slides.forEach((slide, idx) => {
      const isAct = idx === this.activeSlideIndex;
      const icon =
        slide.kind === "board" ? "📐" : slide.kind === "external" ? "🌐" : "🖼";
      const chip = this.slidesBarEl.createEl("button", {
        cls: `my-sc-filter-chip ${isAct ? "is-active" : ""}`,
        text: `${icon} ${slide.label}`,
        attr: { type: "button", title: slide.key },
      });
      chip.onclick = async () => {
        if (this.activeSlideIndex === idx) return;
        this.activeSlideIndex = idx;
        this.selectedElementIds.clear();
        this.lastSelectedId = null;
        this.renderSlidesChips();
        await this.loadActiveSlide();
      };
    });
  }

  private async loadActiveSlide(): Promise<void> {
    const slide = this.slides[this.activeSlideIndex];
    if (!slide || !this.manager) return;

    if (slide.kind === "board") {
      this.imgEl.addClass("is-hidden");
      this.boardBgEl.removeClass("is-hidden");
      this.naturalW = DEFAULT_BOARD_W;
      this.naturalH = DEFAULT_BOARD_H;
      this.boardBgEl.style.width = `${this.naturalW}px`;
      this.boardBgEl.style.height = `${this.naturalH}px`;
    } else {
      this.boardBgEl.addClass("is-hidden");
      this.imgEl.removeClass("is-hidden");
      await this.setImageSrc(slide.src);
      this.naturalW = this.imgEl.naturalWidth || DEFAULT_BOARD_W;
      this.naturalH = this.imgEl.naturalHeight || DEFAULT_BOARD_H;
    }

    this.renderer.syncLayersSize(this.naturalW, this.naturalH);
    this.elementsByMediaKey = await this.manager.loadElements(
      this.naturalW,
      this.naturalH
    );
    CanvasEngine.syncArrowsToBlocks(this.getCurrentElements());
    this.resetHistory();
    this.updatePropertiesPanel();
    this.updateDeleteButton();
    this.renderElements();
    window.requestAnimationFrame(() => this.fitToScreen());
  }

  private setImageSrc(src: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const cleanup = () => {
        this.imgEl.removeEventListener("load", onLoad);
        this.imgEl.removeEventListener("error", onError);
      };
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        resolve();
      };
      this.imgEl.addEventListener("load", onLoad, { once: true });
      this.imgEl.addEventListener("error", onError, { once: true });
      this.imgEl.src = src;
    });
  }

  private getCurrentElements(): CanvasElement[] {
    const slide = this.slides[this.activeSlideIndex];
    if (!slide) return [];
    return this.elementsByMediaKey.get(slide.key) ?? [];
  }

  private setCurrentElements(list: CanvasElement[]): void {
    const slide = this.slides[this.activeSlideIndex];
    if (!slide) return;
    this.elementsByMediaKey.set(slide.key, list);
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

  private commitHistory(persist = true): void {
    const currentState = JSON.stringify(
      Array.from(this.elementsByMediaKey.entries())
    );
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
        this.manager.saveElements(this.elementsByMediaKey).catch(() => {});
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
    const parsed = JSON.parse(stateStr) as [string, CanvasElement[]][];
    this.elementsByMediaKey = new Map(parsed);
    this.selectedElementIds.clear();
    this.lastSelectedId = null;
    this.updatePropertiesPanel();
    this.renderElements();
    this.manager?.saveElements(this.elementsByMediaKey).catch(() => {});
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
    if (!this.deleteBtn) return;
    const has = this.selectedElementIds.size > 0;
    this.deleteBtn.disabled = !has;
    this.deleteBtn.classList.toggle("is-disabled", !has);
  }

  private renderToolbar(parent: HTMLElement): void {
    this.toolbarEl = parent.createDiv({ cls: "mni-toolbar" });
    const tools: { id: ToolType; icon: string; label: string; hotkey: string }[] =
      [
        { id: "pan", icon: "✥", label: "Панорама", hotkey: "H" },
        { id: "select", icon: "🖐️", label: "Выделение", hotkey: "V" },
        { id: "rect", icon: "⬜", label: "Прямоугольник", hotkey: "R" },
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

    this.deleteBtn = this.toolbarEl.createEl("button", {
      cls: "mni-tool-btn mni-tool-delete is-disabled",
      text: "✖",
      attr: { type: "button", title: "Удалить выбранное (Delete)" },
    });
    this.deleteBtn.onclick = () => this.deleteSelected();
  }

  private setTool(tool: ToolType): void {
    this.currentTool = tool;
    this.selectedElementIds.clear();
    this.lastSelectedId = null;
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
      if (btnEl === this.deleteBtn) return;
      btnEl.classList.toggle("is-active", btnEl.dataset.tool === tool);
    });
  }

  private updatePropertiesPanel(): void {
    this.propertiesPanelEl.empty();

    if (!this.lastSelectedId) {
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
      rect: "⬜ Прямоугольник",
      arrow: "↗️ Стрелка",
      text: "T Текст / Ссылка",
    };

    const header = this.propertiesPanelEl.createDiv({ cls: "mni-prop-header" });
    header.createEl("h4", { text: typeLabels[el.type], cls: "mni-prop-title" });

    const createSection = (title: string): HTMLElement => {
      const sec = this.propertiesPanelEl.createDiv({ cls: "mni-prop-group" });
      sec.createDiv({ cls: "mni-prop-group-label", text: title });
      return sec;
    };

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
    const fit = CanvasEngine.computeFitTransform(
      rect.width,
      rect.height,
      this.naturalW,
      this.naturalH
    );
    this.scale = fit.scale;
    this.panX = fit.panX;
    this.panY = fit.panY;
    this.applyTransform();
  }

  private applyTransform(): void {
    this.layerEl.style.transform = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.scale})`;
  }

  private bindKeyboardAndPasteEvents(): void {
    this.keyHandler = (e: KeyboardEvent) => {
      if (!this.container.isConnected || this.container.hasClass("is-hidden")) {
        return;
      }
      const targetTag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(targetTag)) return;

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
          const savedFile = await saveClipboardImageAndAttach(
            this.app,
            this.currentNote.file,
            buf,
            item.type,
            this.callbacks.getMediaFolder()
          );
          new Notice(`Скриншот сохранён и прикреплён: ${savedFile.name}`);
          await this.reloadCurrentNoteMedia(savedFile.name);
          return;
        }
      }
    };

    window.addEventListener("keydown", this.keyHandler);
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

  private bindPointerEvents(target: HTMLElement): void {
    let pointerMoved = false;

    target.addEventListener("dblclick", (e: MouseEvent) => {
      if (this.currentTool !== "select") return;
      const clickedEl = (e.target as HTMLElement).closest(
        ".mni-el-text"
      ) as HTMLElement | null;
      if (!clickedEl) return;
      e.stopPropagation();
      const id = clickedEl.dataset.id;
      if (id) this.spawnTextInput(e.clientX, e.clientY, id);
    });

    target.addEventListener("pointerdown", (e: PointerEvent) => {
      if (
        (e.target as HTMLElement).closest(
          ".mni-toolbar, .mni-properties-panel, .mni-el-input-wrapper, a.internal-link"
        )
      ) {
        return;
      }

      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pointerMoved = false;

      const elements = this.getCurrentElements();

      if (this.currentTool === "select") {
        const svgTarget = e.target as SVGElement;
        const clickedEl = (e.target as HTMLElement).closest(
          ".mni-el, .mni-el-svg"
        ) as HTMLElement | SVGElement | null;

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
            if (!this.selectedElementIds.has(clickedId)) {
              this.selectedElementIds.clear();
              this.selectedElementIds.add(clickedId);
            }
            this.lastSelectedId = clickedId;
            this.updateDeleteButton();
            this.updatePropertiesPanel();
            this.renderer.updateSelectionStates(
              elements,
              this.selectedElementIds
            );

            this.isDraggingEl = true;
            this.dragStartPoint = this.getImageCoords(e.clientX, e.clientY);
            this.groupDragStartPositions.clear();

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
          return;
        }

        this.isMarquee = true;
        this.marqueeStart = this.getImageCoords(e.clientX, e.clientY);
        this.selectedElementIds.clear();
        this.lastSelectedId = null;
        this.updateDeleteButton();
        this.updatePropertiesPanel();
        this.renderer.updateSelectionStates(elements, this.selectedElementIds);

        this.marqueeEl = this.elementsLayerEl.createDiv({ cls: "mni-marquee" });
        this.marqueeEl.style.left = `${this.marqueeStart.x}px`;
        this.marqueeEl.style.top = `${this.marqueeStart.y}px`;
        this.marqueeEl.style.width = "0px";
        this.marqueeEl.style.height = "0px";
        return;
      }

      if (this.currentTool !== "pan" && this.activePointers.size === 1) {
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

      if (
        this.activePointers.size === 1 &&
        !this.isDraggingEl &&
        !this.isDraggingHandle &&
        !this.isMarquee &&
        !this.isResizing
      ) {
        this.isPanning = true;
        target.classList.add("is-dragging");
        this.startPanPoint = { x: e.clientX, y: e.clientY };
        this.startTransform = { x: this.panX, y: this.panY };
      } else if (this.activePointers.size === 2) {
        this.isPanning = false;
        this.prevPinchDistance = this.getPinchDistance();
      }
    });

    target.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this.activePointers.has(e.pointerId)) return;
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (
        Math.abs(e.clientX - this.startPanPoint.x) > 4 ||
        Math.abs(e.clientY - this.startPanPoint.y) > 4
      ) {
        pointerMoved = true;
      }

      const elements = this.getCurrentElements();

      if (this.isResizing && this.lastSelectedId && this.activeResizeHandle) {
        const el = elements.find((x) => x.id === this.lastSelectedId);
        if (!el || el.type === "arrow") return;

        const current = this.getImageCoords(e.clientX, e.clientY);
        const dx = current.x - this.dragStartPoint.x;
        const dy = current.y - this.dragStartPoint.y;

        const nextGeom = CanvasEngine.computeResizedGeometry(
          this.resizeStartBBox,
          this.activeResizeHandle,
          dx,
          dy,
          el.type === "text"
        );

        el.x = nextGeom.x;
        el.y = nextGeom.y;
        el.width = nextGeom.width;
        el.height = nextGeom.height;
        if (el.type === "text" && nextGeom.fontSize !== undefined) {
          el.fontSize = nextGeom.fontSize;
        }

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

      if (this.isDraggingEl && this.groupDragStartPositions.size > 0) {
        const current = this.getImageCoords(e.clientX, e.clientY);
        const dx = current.x - this.dragStartPoint.x;
        const dy = current.y - this.dragStartPoint.y;
        const dirtyIds = new Set<string>();

        this.selectedElementIds.forEach((id) => {
          const el = elements.find((x) => x.id === id);
          const start = this.groupDragStartPositions.get(id);
          if (!el || !start) return;

          if (el.type === "arrow" && start.type === "arrow") {
            el.x1 = start.x1 + dx;
            el.y1 = start.y1 + dy;
            el.x2 = start.x2 + dx;
            el.y2 = start.y2 + dy;
            if (start.cx1 !== undefined && start.cy1 !== undefined) {
              el.cx1 = start.cx1 + dx;
              el.cy1 = start.cy1 + dy;
            }
            if (start.cx2 !== undefined && start.cy2 !== undefined) {
              el.cx2 = start.cx2 + dx;
              el.cy2 = start.cy2 + dy;
            }
            dirtyIds.add(el.id);
          } else if (el.type !== "arrow" && start.type === "box") {
            el.x = start.x + dx;
            el.y = start.y + dy;
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
        this.applyTransform();
        return;
      }

      if (this.activePointers.size === 2) {
        const dist = this.getPinchDistance();
        if (this.prevPinchDistance && dist > 0) {
          const factor = dist / this.prevPinchDistance;
          const center = this.getPinchCenter();
          this.zoomAtPoint(center.x, center.y, factor);
        }
        this.prevPinchDistance = dist;
      }
    });

    const onPointerEnd = (e: PointerEvent) => {
      this.activePointers.delete(e.pointerId);
      this.renderer.showSnapIndicator(null);

      if (this.isResizing) {
        this.isResizing = false;
        this.activeResizeHandle = null;
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
          this.getCurrentElements(),
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
        this.isDraggingEl = false;
        this.groupDragStartPositions.clear();
        if (pointerMoved) this.commitHistory();
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
              x: left,
              y: top,
              width,
              height,
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
              x1: this.drawStartPoint.x,
              y1: this.drawStartPoint.y,
              x2: finalX,
              y2: finalY,
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

      if (this.currentTool === "text" && !pointerMoved) {
        this.spawnTextInput(e.clientX, e.clientY);
      }

      if (this.activePointers.size < 2) this.prevPinchDistance = null;
      if (this.activePointers.size === 1) {
        const remaining = Array.from(this.activePointers.values())[0];
        if (remaining) {
          this.startPanPoint = { x: remaining.x, y: remaining.y };
          this.startTransform = { x: this.panX, y: this.panY };
        }
      } else if (this.activePointers.size === 0) {
        this.isPanning = false;
        target.classList.remove("is-dragging");
      }
    };

    target.addEventListener("pointerup", onPointerEnd);
    target.addEventListener("pointercancel", onPointerEnd);
    target.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        this.zoomAtPoint(e.clientX, e.clientY, factor);
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
    let initialFontSize = Math.max(12, Math.round(16 / this.scale));
    let initialWidth = Math.max(140, Math.round(220 / this.scale));

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
    wrapper.style.left = `${coords.x}px`;
    wrapper.style.top = `${coords.y}px`;
    wrapper.style.width = `${initialWidth}px`;

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
      const nextH = Math.max(40, textarea.scrollHeight);
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
      const finalHeight = Math.max(32, wrapper.offsetHeight || 42);
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
          existing.width = finalWidth;
          existing.height = finalHeight;
          targetId = existing.id;
        }
      } else {
        const newText: TextElement = {
          id: `text_${Date.now()}`,
          type: "text",
          x: coords.x,
          y: coords.y,
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
    this.scale = next.scale;
    this.panX = next.panX;
    this.panY = next.panY;
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
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = undefined;
    }
    if (this.pasteHandler) {
      window.removeEventListener("paste", this.pasteHandler);
      this.pasteHandler = undefined;
    }
    this.renderer?.destroy();
    this.manager?.saveElements(this.elementsByMediaKey).catch(() => {});
    this.container.empty();
  }
}