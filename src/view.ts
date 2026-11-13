// C:\Users\user\dev\my-study-compiler\src\view.ts
import {
	App,
FuzzySuggestModal,
	ItemView,
	Menu,
	Notice,
	TAbstractFile,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
} from "obsidian";
import type MyStudyCompilerPlugin from "./main";
import {
	CameraState,
	CustomPropertyDraft,
	KEYS,
	OpenOptions,
	Point,
	ProjectGroupTab,
	QuickFilterMode,
	ROOT_STATUS_ACTIVE,
	ROOT_STATUS_DONE,
	StudyCompilerViewState,
	StudyNoteItem,
	TreeNode,
	VIEW_TYPE_STUDY_COMPILER,
	ViewMode,
} from "./types";
import {
	ScanResult,
	buildBreadcrumbChain,
	buildNestedFilteredTree,
	byName,
	collectDescendants,
	emptyScan,
	ensureFolder,
	findCaseInsensitiveTypeMatch,
	findRootPath,
	flattenVisibleTree,
	formatDeadlineBadge,
	formatFullDateTooltip,
	getDeadlineTone,
getWorkMeta,
	isReservedYamlKey,
	isTemplateOrExcludedFile,
	normalizeSpaces,
	parseCustomPropertyValue,
	scanStudyVault,
	serializeYamlScalarOrList,
	todayISO,
} from "./scanner";
import { animateClose, animateOpen, prefersReducedMotion } from "./motion";
import { ProjectGraphView } from "./graph";
import { ProjectSchemaView } from "./canvasView";

interface WebkitFullscreenDocument extends Document {
	webkitFullscreenElement?: Element | null;
	webkitFullscreenEnabled?: boolean;
	webkitExitFullscreen?: () => Promise<void> | void;
}

interface WebkitFullscreenHTMLElement extends HTMLElement {
	webkitRequestFullscreen?: () => Promise<void> | void;
}

class ParentPickerModal extends FuzzySuggestModal<StudyNoteItem> {
	private items: StudyNoteItem[];
	private onPick: (item: StudyNoteItem) => void;

	constructor(app: App, items: StudyNoteItem[], onPick: (item: StudyNoteItem) => void) {
		super(app);
		this.items = items;
		this.onPick = onPick;
		this.setPlaceholder("Выбери нового родителя…");
	}

	getItems(): StudyNoteItem[] {
		return this.items;
	}

	getItemText(item: StudyNoteItem): string {
		return `${item.name} · ${item.noteType || "без типа"}`;
	}

	onChooseItem(item: StudyNoteItem): void {
		this.onPick(item);
	}
}

export class StudyCompilerView extends ItemView {
	private plugin: MyStudyCompilerPlugin;
	private scan: ScanResult = emptyScan();
	private groupTab: ProjectGroupTab;
	private selectedPath = "";
	private focusBranchPath = "";
	private schemaNotePath = "";
	private activeCanvasKey = "";
	private savedSchemaCamera: CameraState | null = null;
	private savedGraphCamera: CameraState | null = null;
	private isFocusMode = false;
	private isPseudoFullscreen = false;

	private expanded: Set<string>;
	private refreshTimer: number | null = null;
	private stateSaveTimer: number | null = null;
	private freshTimer: number | null = null;
	private rootResizeObserver: ResizeObserver | null = null;
	private currentWin: Window | null = null;
	private boundWinKeyDown?: (e: KeyboardEvent) => void;
	private boundFullscreenChange?: () => void;

	private searchQuery = "";
	private filterMode: QuickFilterMode = "all";
	private typeFilter = "";
	private activeRowIndex = -1;
	private currentVisibleFlat: TreeNode[] = [];
	private rowElementByPath = new Map<string, HTMLElement>();

	private knownPaths: Set<string> = new Set();
	private freshPaths = new Set<string>();
	private pendingOpenPath: string | null = null;
	private closingBranch = false;
	private closed = false;

	private viewMode: ViewMode = "tree";
	private graphView: ProjectGraphView | null = null;
	private schemaView: ProjectSchemaView | null = null;
	private lastGraphRootPath = "";
	private expandToggleBtn: HTMLButtonElement | null = null;
	private focusModeBtn: HTMLButtonElement | null = null;
	private fullscreenBtn: HTMLButtonElement | null = null;
	private floatingFullscreenBtn: HTMLButtonElement | null = null;

private editingNodePath: string | null = null;
	private editingNodeMode: "type" | "props" | null = null;
	private draggedNodePath: string | null = null;

	private rootHostEl!: HTMLElement;
	private focusFloatingBarEl!: HTMLElement;
	private barEl!: HTMLElement;
	private searchWrapEl!: HTMLElement;
	private crumbsEl!: HTMLElement;
	private formEl!: HTMLElement;
	private workspaceBodyEl!: HTMLElement;
	private treeEl!: HTMLElement;
	private graphEl!: HTMLElement;
	private schemaEl!: HTMLElement;
	private datalistsEl!: HTMLElement;
	private searchInputEl: HTMLInputElement | null = null;
	private workSelectEl: HTMLSelectElement | null = null;

	private form: {
		open: boolean;
		title: string;
		type: string;
		parentPath: string;
		deadline: string;
		customProps: CustomPropertyDraft[];
	};

	constructor(leaf: WorkspaceLeaf, plugin: MyStudyCompilerPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = false;
		this.groupTab = plugin.settings.projectGroupTab || "active";
		this.selectedPath = plugin.settings.lastWorkPath || "";
		this.expanded = new Set(plugin.settings.expandedPaths);
		this.form = {
			open: false,
			title: "",
			type: plugin.settings.lastUsedMaterialType || "Термин",
			parentPath: "",
			deadline: "",
			customProps: [],
		};
	}

	getViewType(): string {
		return VIEW_TYPE_STUDY_COMPILER;
	}

	getDisplayText(): string {
		const root = this.scan.byPath.get(this.selectedPath);
		const modeLabel =
			this.viewMode === "schema"
				? "Схема"
				: this.viewMode === "graph"
					? "Граф"
					: "Дерево";
		return root ? `${root.name} · ${modeLabel}` : "Учебные проекты";
	}

	getIcon(): string {
		return "folder-tree";
	}

	private get win(): Window {
		return this.containerEl.win ?? activeWindow ?? window;
	}

	private get doc(): Document {
		return this.containerEl.doc ?? activeDocument ?? document;
	}

	private focusSafeContainer(): void {
		if (this.closed || !this.rootHostEl) return;
		const active = this.doc.activeElement;
		if (
			active instanceof HTMLSelectElement ||
			active instanceof HTMLInputElement ||
			active instanceof HTMLTextAreaElement ||
			active instanceof HTMLButtonElement
		) {
			active.blur();
		}
		this.rootHostEl.focus({ preventScroll: true });
	}

	async onOpen(): Promise<void> {
		this.closed = false;
		const host = this.contentEl;
		host.empty();
		host.addClass("my-sc-view-content");

		this.rootHostEl = host.createDiv("my-sc-modal my-sc-workspace-root");
		this.rootHostEl.setAttribute("tabindex", "-1");

		this.datalistsEl = this.rootHostEl.createDiv("my-sc-datalists-host");
		this.barEl = this.rootHostEl.createDiv("my-sc-project-bar");
		this.searchWrapEl = this.rootHostEl.createDiv("my-sc-search-panel");
		this.crumbsEl = this.rootHostEl.createDiv("my-sc-crumbs-bar");
		this.formEl = this.rootHostEl.createDiv("my-sc-form-wrap");

		this.workspaceBodyEl = this.rootHostEl.createDiv("my-sc-workspace-stage");
		this.treeEl = this.workspaceBodyEl.createDiv("my-sc-body");
		this.graphEl = this.workspaceBodyEl.createDiv("my-sc-graph-wrap is-hidden");
		this.schemaEl = this.workspaceBodyEl.createDiv("my-sc-schema-wrap is-hidden");

		this.buildFocusFloatingBar();

		this.registerDomEvent(this.rootHostEl, "keydown", (e: KeyboardEvent) => {
			this.handleKeyboardNav(e);
		});

		this.bindWindowEvents(this.win);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.bindWindowEvents(this.win);
			})
		);

const onFileEvent = (file: TAbstractFile) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			const cache = this.app.metadataCache.getFileCache(file);
			if (isTemplateOrExcludedFile(file, cache?.frontmatter, [], this.plugin.settings)) {
				return;
			}
			this.scheduleRefresh();
		};
		this.registerEvent(this.app.metadataCache.on("changed", onFileEvent));
		this.registerEvent(this.app.vault.on("delete", onFileEvent));
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (this.scan.byPath.has(oldPath)) {
					this.scheduleRefresh();
					return;
				}
				onFileEvent(file);
			})
		);

		if (typeof ResizeObserver !== "undefined") {
			this.rootResizeObserver = new ResizeObserver(() => {
				if (this.closed) return;
				this.graphView?.notifyResize();
				this.schemaView?.notifyResize();
			});
			this.rootResizeObserver.observe(this.rootHostEl);
		}

		this.scan = scanStudyVault(this.app, this.plugin.settings);
		this.knownPaths = new Set(this.scan.byPath.keys());

		this.syncGroupTabWithSelectedProject();
		const root = this.getRootInCurrentGroup();
		if (root && !this.focusBranchPath) {
			const savedFocus = this.plugin.settings.focusedBranchByWork[root.path];
			if (savedFocus && this.scan.byPath.has(savedFocus)) {
				this.focusBranchPath = savedFocus;
			}
		}

		this.renderDatalists();
		this.renderBar();
		this.renderSearchPanel();
		this.renderBreadcrumbs();
		this.applyViewMode();
		this.renderMain();
	}

	async onClose(): Promise<void> {
		this.closed = true;
		if (this.isPseudoFullscreen) {
			this.setPseudoFullscreen(false);
		}
		const fsDoc = this.doc as WebkitFullscreenDocument;
		const activeFsEl = fsDoc.fullscreenElement ?? fsDoc.webkitFullscreenElement ?? null;
		if (activeFsEl && (activeFsEl === this.rootHostEl || this.rootHostEl?.contains(activeFsEl))) {
			try {
				if (typeof fsDoc.exitFullscreen === "function") {
					await fsDoc.exitFullscreen();
				} else if (typeof fsDoc.webkitExitFullscreen === "function") {
					await fsDoc.webkitExitFullscreen();
				}
			} catch {
				// игнорируем при закрытии вида
			}
		}
		this.unbindWindowEvents();

		if (this.rootResizeObserver) {
			this.rootResizeObserver.disconnect();
			this.rootResizeObserver = null;
		}
		if (this.refreshTimer !== null) {
			this.win.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.stateSaveTimer !== null) {
			this.win.clearTimeout(this.stateSaveTimer);
			this.stateSaveTimer = null;
		}
		if (this.freshTimer !== null) {
			this.win.clearTimeout(this.freshTimer);
			this.freshTimer = null;
		}

		this.freshPaths.clear();
		if (this.graphView) {
			this.graphView.destroy();
			this.graphView = null;
		}
		if (this.schemaView) {
			await this.schemaView.destroy();
			this.schemaView = null;
		}
		this.lastGraphRootPath = "";
		this.expandToggleBtn = null;
		this.focusModeBtn = null;
		this.fullscreenBtn = null;
		this.floatingFullscreenBtn = null;
		this.workSelectEl = null;
		this.searchInputEl = null;
		this.contentEl.empty();
	}

	getState(): StudyCompilerViewState {
		const schemaCam = this.schemaView
			? this.schemaView.getCameraState()
			: this.savedSchemaCamera;
		const graphCam = this.graphView
			? this.graphView.getCameraState()
			: this.savedGraphCamera;
		const activeKey = this.schemaView
			? this.schemaView.getActiveSlideKey() || this.activeCanvasKey
			: this.activeCanvasKey;

		return {
			projectPath: this.selectedPath,
			focusBranchPath: this.focusBranchPath,
			viewMode: this.viewMode,
			schemaNotePath: this.schemaNotePath,
			activeCanvasKey: activeKey,
			camera: schemaCam,
			graphCamera: graphCam,
			isFocusMode: this.isFocusMode,
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		if (!state || typeof state !== "object") return;
		const s = state as StudyCompilerViewState;

		if (typeof s.projectPath === "string" && s.projectPath.trim()) {
			this.selectedPath = s.projectPath.trim();
		}
		if (typeof s.focusBranchPath === "string") {
			this.focusBranchPath = s.focusBranchPath.trim();
		}
		if (typeof s.schemaNotePath === "string") {
			this.schemaNotePath = s.schemaNotePath.trim();
		}
		if (typeof s.activeCanvasKey === "string") {
			this.activeCanvasKey = s.activeCanvasKey.trim();
		}
		if (s.viewMode === "tree" || s.viewMode === "graph" || s.viewMode === "schema") {
			this.viewMode = s.viewMode;
		}
		if (typeof s.isFocusMode === "boolean") {
			this.isFocusMode = s.isFocusMode;
		}
		if (
			s.camera &&
			typeof s.camera.scale === "number" &&
			typeof s.camera.panX === "number" &&
			typeof s.camera.panY === "number"
		) {
			this.savedSchemaCamera = {
				scale: s.camera.scale,
				panX: s.camera.panX,
				panY: s.camera.panY,
			};
		}
		if (
			s.graphCamera &&
			typeof s.graphCamera.scale === "number" &&
			typeof s.graphCamera.panX === "number" &&
			typeof s.graphCamera.panY === "number"
		) {
			this.savedGraphCamera = {
				scale: s.graphCamera.scale,
				panX: s.graphCamera.panX,
				panY: s.graphCamera.panY,
			};
		}

		if (!this.rootHostEl) return;

		this.scan = scanStudyVault(this.app, this.plugin.settings);
		if (s.addUnder && this.scan.byPath.has(s.addUnder)) {
			this.selectedPath = findRootPath(this.scan, s.addUnder);
		} else if (this.schemaNotePath && this.scan.byPath.has(this.schemaNotePath)) {
			this.selectedPath = findRootPath(this.scan, this.schemaNotePath);
		}

		this.syncGroupTabWithSelectedProject();
		this.renderDatalists();
		this.renderBar();
		this.renderSearchPanel();
		this.renderBreadcrumbs();
		this.applyViewMode();
		this.renderMain();

		if (s.addUnder && this.scan.byPath.has(s.addUnder)) {
			this.openForm(s.addUnder, true);
		}
	}

	public applyOpenOptions(options: OpenOptions): void {
		if (!this.rootHostEl) return;

		this.scan = scanStudyVault(this.app, this.plugin.settings);

		if (options.rootPath && this.scan.byPath.has(options.rootPath)) {
			this.selectedPath = findRootPath(this.scan, options.rootPath);
		}
		if (options.addUnder && this.scan.byPath.has(options.addUnder)) {
			this.selectedPath = findRootPath(this.scan, options.addUnder);
		}
		if (options.schemaNotePath && this.scan.byPath.has(options.schemaNotePath)) {
			this.schemaNotePath = options.schemaNotePath;
			this.selectedPath = findRootPath(this.scan, options.schemaNotePath);
			this.viewMode = "schema";
		}
		if (options.activeCanvasKey) {
			this.activeCanvasKey = options.activeCanvasKey;
		}
		if (options.viewMode) {
			this.viewMode = options.viewMode;
		}

		this.syncGroupTabWithSelectedProject();
		this.renderDatalists();
		this.renderBar();
		this.renderSearchPanel();
		this.renderBreadcrumbs();
		this.applyViewMode();
		this.renderMain();

		if (options.addUnder && this.scan.byPath.has(options.addUnder)) {
			this.openForm(options.addUnder, true);
		}
		this.requestSaveViewState();
	}

	private requestSaveViewState(): void {
		if (this.closed) return;
		if (this.stateSaveTimer !== null) {
			this.win.clearTimeout(this.stateSaveTimer);
		}
		this.stateSaveTimer = this.win.setTimeout(() => {
			this.stateSaveTimer = null;
			if (!this.closed) {
				this.app.workspace.requestSaveLayout();
				(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
			}
		}, 250);
	}

	private bindWindowEvents(targetWin: Window): void {
		if (this.currentWin === targetWin) return;
		this.unbindWindowEvents();
		this.currentWin = targetWin;

		this.boundWinKeyDown = (e: KeyboardEvent) => {
			if (this.closed || !this.containerEl.isShown()) return;
			const activeLeaf = this.app.workspace.getMostRecentLeaf();
			if (
				activeLeaf &&
				activeLeaf !== this.leaf &&
				!this.rootHostEl.contains(this.doc.activeElement) &&
				!this.isFullscreenActive()
			) {
				return;
			}
			if (e.key === "F11") {
				e.preventDefault();
				e.stopPropagation();
				void this.toggleFullscreen();
			} else if (e.key === "Escape") {
				const target = e.target as HTMLElement | null;
				const tag = target?.tagName ?? "";
				if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || target?.isContentEditable) {
					return;
				}
				if (this.isPseudoFullscreen) {
					e.preventDefault();
					e.stopPropagation();
					this.setPseudoFullscreen(false);
					return;
				}
				if (this.isFocusMode && !this.getNativeFullscreenElement()) {
					this.toggleFocusMode(false);
				}
			}
		};

		this.boundFullscreenChange = () => {
			if (this.getNativeFullscreenElement() && this.isPseudoFullscreen) {
				this.isPseudoFullscreen = false;
				this.applyPseudoFullscreenClasses(false);
			}
			this.syncFullscreenButtonState();
			this.scheduleViewportResize();
		};

		targetWin.addEventListener("keydown", this.boundWinKeyDown, true);
		targetWin.document.addEventListener("fullscreenchange", this.boundFullscreenChange);
		targetWin.document.addEventListener("webkitfullscreenchange", this.boundFullscreenChange);
	}

	private unbindWindowEvents(): void {
		if (!this.currentWin) return;
		if (this.boundWinKeyDown) {
			this.currentWin.removeEventListener("keydown", this.boundWinKeyDown, true);
			this.boundWinKeyDown = undefined;
		}
		if (this.boundFullscreenChange) {
			this.currentWin.document.removeEventListener(
				"fullscreenchange",
				this.boundFullscreenChange
			);
			this.currentWin.document.removeEventListener(
				"webkitfullscreenchange",
				this.boundFullscreenChange
			);
			this.boundFullscreenChange = undefined;
		}
		this.currentWin = null;
	}

	private buildFocusFloatingBar(): void {
		this.focusFloatingBarEl = this.rootHostEl.createDiv(
			"my-sc-focus-floating-bar is-hidden"
		);

		const exitFocusBtn = this.focusFloatingBarEl.createEl("button", {
			cls: "my-sc-chip-btn",
			text: "Показать шапку",
			attr: { type: "button", title: "Выйти из режима фокусировки (Esc)" },
		});
		exitFocusBtn.onclick = () => this.toggleFocusMode(false);

		this.floatingFullscreenBtn = this.focusFloatingBarEl.createEl("button", {
			cls: "my-sc-icon-btn",
			attr: {
				type: "button",
				title: "Полный экран (F11)",
				"aria-label": "Полный экран (F11)",
			},
		});
		setIcon(this.floatingFullscreenBtn, "maximize-2");
		this.floatingFullscreenBtn.onclick = () => void this.toggleFullscreen();
	}

	private toggleFocusMode(force?: boolean): void {
		this.isFocusMode = force !== undefined ? force : !this.isFocusMode;
		this.rootHostEl.toggleClass("is-focus-mode", this.isFocusMode);
		this.focusFloatingBarEl.toggleClass("is-hidden", !this.isFocusMode);
		if (this.focusModeBtn) {
			this.focusModeBtn.toggleClass("is-active", this.isFocusMode);
		}
		this.requestSaveViewState();
		this.scheduleViewportResize();
	}

	private getNativeFullscreenElement(): Element | null {
		const d = this.doc as WebkitFullscreenDocument;
		return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
	}

	private isFullscreenActive(): boolean {
		return Boolean(this.getNativeFullscreenElement()) || this.isPseudoFullscreen;
	}

	private applyPseudoFullscreenClasses(active: boolean): void {
		this.rootHostEl?.toggleClass("is-pseudo-fullscreen", active);
		this.contentEl?.toggleClass("is-pseudo-fullscreen-parent", active);
		this.containerEl?.toggleClass("is-pseudo-fullscreen-leaf", active);
		this.doc.body?.classList.toggle("my-sc-body-pseudo-fullscreen", active);
	}

	private setPseudoFullscreen(active: boolean): void {
		this.isPseudoFullscreen = active;
		this.applyPseudoFullscreenClasses(active);
		this.syncFullscreenButtonState();
		this.scheduleViewportResize();
	}

	private scheduleViewportResize(): void {
		this.win.requestAnimationFrame(() => {
			if (this.closed) return;
			this.graphView?.notifyResize();
			this.schemaView?.notifyResize();
		});
	}

	private async toggleFullscreen(): Promise<void> {
		const d = this.doc as WebkitFullscreenDocument;
		const hostEl = this.rootHostEl as WebkitFullscreenHTMLElement;
		const nativeFsEl = this.getNativeFullscreenElement();

		if (nativeFsEl) {
			try {
				if (typeof d.exitFullscreen === "function") {
					await d.exitFullscreen();
				} else if (typeof d.webkitExitFullscreen === "function") {
					await d.webkitExitFullscreen();
				}
			} catch {
				// игнорируем и синхронизируем состояние
			}
			this.syncFullscreenButtonState();
			this.scheduleViewportResize();
			return;
		}

		if (this.isPseudoFullscreen) {
			this.setPseudoFullscreen(false);
			return;
		}

		const canUseStandard =
			typeof hostEl.requestFullscreen === "function" &&
			d.fullscreenEnabled !== false;
		const canUseWebkit =
			typeof hostEl.webkitRequestFullscreen === "function" &&
			d.webkitFullscreenEnabled !== false;

		if (canUseStandard || canUseWebkit) {
			try {
				if (canUseStandard && hostEl.requestFullscreen) {
					await hostEl.requestFullscreen();
				} else if (canUseWebkit && hostEl.webkitRequestFullscreen) {
					await hostEl.webkitRequestFullscreen();
				}
				if (this.getNativeFullscreenElement()) {
					this.syncFullscreenButtonState();
					this.scheduleViewportResize();
					return;
				}
			} catch {
				// На iPad / в мобильном WebView вызов может быть отклонён — включаем псевдо-полноэкранный режим
			}
		}

		this.setPseudoFullscreen(true);
	}

	private syncFullscreenButtonState(): void {
		const isFs = this.isFullscreenActive();
		this.rootHostEl?.toggleClass("is-fullscreen", isFs);
		this.applyPseudoFullscreenClasses(this.isPseudoFullscreen);

		const title = isFs
			? "Выйти из полного экрана (F11 / Esc)"
			: "Полный экран (F11)";

		for (const btn of [this.fullscreenBtn, this.floatingFullscreenBtn]) {
			if (!btn) continue;
			btn.empty();
			setIcon(btn, isFs ? "minimize-2" : "maximize-2");
			btn.toggleClass("is-active", isFs);
			btn.setAttribute("title", title);
			btn.setAttribute("aria-label", title);
		}
	}

	private syncGroupTabWithSelectedProject(): void {
		if (!this.selectedPath) return;
		const found = this.scan.roots.find((r) => r.path === this.selectedPath);
		if (!found) return;
		const targetGroup: ProjectGroupTab = found.isCompletedRoot ? "completed" : "active";
		if (this.groupTab !== targetGroup) {
			this.groupTab = targetGroup;
			this.plugin.settings.projectGroupTab = targetGroup;
			this.plugin.requestSaveSettings();
		}
	}

	private getRootsForTab(tab: ProjectGroupTab): StudyNoteItem[] {
		return tab === "completed" ? this.scan.completedRoots : this.scan.activeRoots;
	}

	private getRootInCurrentGroup(): StudyNoteItem | null {
		const groupList = this.getRootsForTab(this.groupTab);
		const direct = groupList.find((r) => r.path === this.selectedPath);
		if (direct) return direct;
		const first = groupList[0] ?? null;
		if (first) {
			this.selectedPath = first.path;
			this.plugin.settings.lastWorkPath = first.path;
			this.plugin.requestSaveSettings();
		}
		return first;
	}

	private resolveRootWithFallback(): StudyNoteItem | null {
		const root = this.getRootInCurrentGroup();
		if (root) return root;
		const other: ProjectGroupTab = this.groupTab === "active" ? "completed" : "active";
		if (this.getRootsForTab(other).length === 0) return null;
		this.groupTab = other;
		this.plugin.settings.projectGroupTab = other;
		this.plugin.requestSaveSettings();
		return this.getRootInCurrentGroup();
	}

	private applyViewMode(): void {
		const isTree = this.viewMode === "tree";
		const isGraph = this.viewMode === "graph";
		const isSchema = this.viewMode === "schema";

		this.rootHostEl.toggleClass("is-schema-mode", isSchema);
		this.rootHostEl.toggleClass("is-focus-mode", this.isFocusMode);
		this.focusFloatingBarEl.toggleClass("is-hidden", !this.isFocusMode);

		this.searchWrapEl.toggleClass("is-hidden", !isTree);
		this.crumbsEl.toggleClass("is-hidden", isSchema || !this.focusBranchPath);
		this.treeEl.toggleClass("is-hidden", !isTree);
		this.graphEl.toggleClass("is-hidden", !isGraph);
		this.schemaEl.toggleClass("is-hidden", !isSchema);
	}

	private setViewMode(mode: ViewMode): void {
		if (this.viewMode === mode) return;
		this.viewMode = mode;
		this.applyViewMode();
		this.renderBar();
		this.renderBreadcrumbs();
		this.renderMain();
		this.focusSafeContainer();
		this.requestSaveViewState();
	}

	private openSchemaForNode(notePath: string): void {
		this.schemaNotePath = notePath;
		if (this.viewMode !== "schema") {
			this.viewMode = "schema";
			this.applyViewMode();
			this.renderBar();
			this.renderBreadcrumbs();
		}
		this.renderSchema();
		this.focusSafeContainer();
		this.requestSaveViewState();
	}

	private renderMain(): void {
		if (this.viewMode === "graph") this.renderGraph();
		else if (this.viewMode === "schema") this.renderSchema();
		else this.renderTree();
	}

	private renderGraph(): void {
		const root = this.getRootInCurrentGroup();
		if (!root) {
			if (this.graphView) {
				this.graphView.destroy();
				this.graphView = null;
			}
			this.lastGraphRootPath = "";
			this.graphEl.empty();
			return;
		}
		const branchRoot = this.getActiveBranchRoot(root);

		if (!this.graphView) {
			this.graphView = new ProjectGraphView(this.graphEl, {
				onOpen: (p, newTab) => this.openNote(p, newTab),
				onFocus: (p) => {
					const r = this.getRootInCurrentGroup();
					if (r) this.setFocusBranch(r, p);
				},
onOpenSchema: (p) => this.openSchemaForNode(p),
				onHover: (evt, targetEl, p) => this.triggerHoverPreview(evt, targetEl, p),
				getSavedPositions: (graphKey: string) =>
					this.plugin.settings.graphNodePositions[graphKey] ?? {},
				onSaveNodePosition: (graphKey: string, nodePath: string, pos: Point) => {
					if (!this.plugin.settings.graphNodePositions[graphKey]) {
						this.plugin.settings.graphNodePositions[graphKey] = {};
					}
					this.plugin.settings.graphNodePositions[graphKey]![nodePath] = {
						x: Math.round(pos.x),
						y: Math.round(pos.y),
					};
					this.plugin.requestSaveSettings();
				},
				onResetNodePositions: (graphKey: string) => {
					if (this.plugin.settings.graphNodePositions[graphKey]) {
						delete this.plugin.settings.graphNodePositions[graphKey];
						this.plugin.requestSaveSettings();
					}
				},
				onCameraChange: (cam: CameraState) => {
					this.savedGraphCamera = cam;
					this.requestSaveViewState();
				},
			});
			this.lastGraphRootPath = "";
		}

		const reset = this.lastGraphRootPath !== branchRoot.path;
		this.lastGraphRootPath = branchRoot.path;
		this.graphView.update(
			this.scan,
			branchRoot,
			reset,
			this.freshPaths,
			reset ? this.savedGraphCamera : null
		);
		this.savedGraphCamera = null;
	}

	private renderSchema(): void {
		const root = this.getRootInCurrentGroup();
		if (!root) {
			if (this.schemaView) {
				void this.schemaView.destroy();
				this.schemaView = null;
			}
			this.schemaEl.empty();
			return;
		}

		const branchRoot = this.getActiveBranchRoot(root);
		let targetNote = this.schemaNotePath
			? this.scan.byPath.get(this.schemaNotePath)
			: undefined;

		if (!targetNote || findRootPath(this.scan, targetNote.path) !== root.path) {
			targetNote = branchRoot;
			this.schemaNotePath = targetNote.path;
		}

		if (!this.schemaView) {
			this.schemaView = new ProjectSchemaView(this.app, this.schemaEl, {
				onSelectNote: (nextPath) => {
					this.schemaNotePath = nextPath;
					this.activeCanvasKey = "";
					this.savedSchemaCamera = null;
					this.renderSchema();
					this.requestSaveViewState();
				},
				onOpenNote: (path, newTab) => this.openNote(path, newTab),
				getMediaFolder: () => this.plugin.settings.mediaFolder || "Знания/Вложения",
				onStateChange: (slideKey, cam) => {
					this.activeCanvasKey = slideKey;
					this.savedSchemaCamera = cam;
					this.requestSaveViewState();
				},
			});
		}

		void this.schemaView.update(
			this.scan,
			root,
			targetNote,
			this.activeCanvasKey || undefined,
			this.savedSchemaCamera
		);
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) this.win.clearTimeout(this.refreshTimer);
		this.refreshTimer = this.win.setTimeout(() => {
			this.refreshTimer = null;
			if (this.closed) return;

			if (
				this.viewMode === "schema" &&
				this.doc.activeElement instanceof HTMLTextAreaElement &&
				(this.doc.activeElement.classList.contains("mni-text-input") ||
					this.doc.activeElement.classList.contains("my-sc-canvas-text-editor"))
			) {
				return;
			}

			const wasSearchFocused = this.doc.activeElement === this.searchInputEl;
			const inFormOrInlineInput =
				this.doc.activeElement instanceof HTMLInputElement &&
				this.doc.activeElement !== this.searchInputEl;

			const next = scanStudyVault(this.app, this.plugin.settings);
			const fresh: string[] = [];
			for (const p of next.byPath.keys()) {
				if (!this.knownPaths.has(p)) fresh.push(p);
			}
			this.knownPaths = new Set(next.byPath.keys());
			this.scan = next;
			if (fresh.length > 0 && fresh.length <= 20) this.markFresh(fresh);

			this.renderDatalists();
			this.renderBar();
			this.renderSearchPanel();
			this.renderBreadcrumbs();
			if (this.form.open && !inFormOrInlineInput) this.renderForm(false);
			if (this.viewMode !== "schema") {
				this.renderMain();
			}

			if (wasSearchFocused && this.searchInputEl) {
				this.searchInputEl.focus({ preventScroll: true });
			}

			if (this.viewMode === "tree") {
				const firstFresh = fresh
					.map((p) => this.rowElementByPath.get(p))
					.find((el): el is HTMLElement => el !== undefined);
				if (firstFresh) {
					firstFresh.scrollIntoView({
						block: "nearest",
						behavior: prefersReducedMotion() ? "auto" : "smooth",
					});
				}
			}
		}, 220);
	}

	private markFresh(paths: string[]): void {
		for (const p of paths) this.freshPaths.add(p);
		if (this.freshTimer !== null) this.win.clearTimeout(this.freshTimer);
		this.freshTimer = this.win.setTimeout(() => {
			this.freshTimer = null;
			for (const p of this.freshPaths) {
				this.rowElementByPath.get(p)?.removeClass("is-new");
			}
			this.freshPaths.clear();
			this.graphView?.clearFresh();
		}, 2400);
	}

	private getChildrenContainer(path: string): HTMLElement | null {
		const group = this.rowElementByPath.get(path)?.parentElement;
		return group?.querySelector<HTMLElement>(".my-sc-children-container") ?? null;
	}

	private toggleBranch(path: string): void {
		if (this.closingBranch) return;

		if (!this.expanded.has(path)) {
			this.expanded.add(path);
			this.saveExpanded();
			this.pendingOpenPath = path;
			this.renderTree();
			return;
		}

		this.expanded.delete(path);
		this.saveExpanded();
		const kids = this.getChildrenContainer(path);
		if (!kids || prefersReducedMotion()) {
			this.renderTree();
			return;
		}
		this.rowElementByPath
			.get(path)
			?.querySelector(".my-sc-toggle-btn")
			?.removeClass("is-open");
		this.closingBranch = true;
		void animateClose(kids).then(() => {
			this.closingBranch = false;
			if (!this.closed) this.renderTree();
		});
	}

	private renderDatalists(): void {
		this.datalistsEl.empty();

		const typeDl = this.datalistsEl.createEl("datalist", {
			attr: { id: "my-sc-types-datalist" },
		});
		for (const t of this.scan.schema.typeCounts) {
			typeDl.createEl("option", {
				attr: { value: t.name, label: `${t.name} (${t.count})` },
			});
		}

		const keysDl = this.datalistsEl.createEl("datalist", {
			attr: { id: "my-sc-prop-keys-datalist" },
		});
		for (const k of this.scan.schema.propertyKeys) {
			keysDl.createEl("option", { attr: { value: k } });
		}
	}

	private getActiveBranchRoot(projectRoot: StudyNoteItem): StudyNoteItem {
		if (this.focusBranchPath) {
			const target = this.scan.byPath.get(this.focusBranchPath);
			if (target && findRootPath(this.scan, target.path) === projectRoot.path) {
				return target;
			}
		}
		this.focusBranchPath = "";
		return projectRoot;
	}

	private setFocusBranch(projectRoot: StudyNoteItem, branchPath: string): void {
		this.focusBranchPath = branchPath === projectRoot.path ? "" : branchPath;
		if (this.focusBranchPath) {
			this.plugin.settings.focusedBranchByWork[projectRoot.path] = this.focusBranchPath;
		} else {
			delete this.plugin.settings.focusedBranchByWork[projectRoot.path];
		}
		this.plugin.requestSaveSettings();
		this.activeRowIndex = -1;
		this.renderBar();
		this.renderBreadcrumbs();
		this.renderMain();
		this.focusSafeContainer();
		this.requestSaveViewState();
	}

	private saveExpanded(): void {
		this.plugin.settings.expandedPaths = [...this.expanded];
		this.plugin.requestSaveSettings();
	}

	private handleKeyboardNav(e: KeyboardEvent): void {
		if (this.viewMode !== "tree") return;

		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
			e.preventDefault();
			this.searchInputEl?.focus();
			this.searchInputEl?.select();
			return;
		}

		const activeEl = this.doc.activeElement;
		const inOtherInput =
			(activeEl instanceof HTMLInputElement && activeEl !== this.searchInputEl) ||
			activeEl instanceof HTMLSelectElement ||
			activeEl instanceof HTMLTextAreaElement;
		if (inOtherInput) return;

		const len = this.currentVisibleFlat.length;
		if (len === 0) return;

		if (e.key === "ArrowDown") {
			e.preventDefault();
			this.activeRowIndex = Math.min(len - 1, this.activeRowIndex + 1);
			this.highlightActiveRow();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			this.activeRowIndex = Math.max(0, this.activeRowIndex - 1);
			this.highlightActiveRow();
		} else if (e.key === "Enter" && this.activeRowIndex >= 0) {
			const picked = this.currentVisibleFlat[this.activeRowIndex];
			if (picked) {
				e.preventDefault();
				this.openNote(picked.item.path, e.ctrlKey || e.metaKey);
			}
		} else if (
			(e.key === "ArrowRight" || e.key === "ArrowLeft") &&
			activeEl !== this.searchInputEl &&
			this.activeRowIndex >= 0
		) {
			const picked = this.currentVisibleFlat[this.activeRowIndex];
			if (!picked || !picked.hasChildren) return;
			const isOpen = this.expanded.has(picked.item.path);
			if (e.key === "ArrowRight" && isOpen) return;
			if (e.key === "ArrowLeft" && !isOpen) return;
			e.preventDefault();
			this.toggleBranch(picked.item.path);
		}
	}

	private highlightActiveRow(): void {
		for (const el of this.rowElementByPath.values()) {
			el.removeClass("is-kb-active");
		}
		const picked = this.currentVisibleFlat[this.activeRowIndex];
		if (!picked) return;
		const targetEl = this.rowElementByPath.get(picked.item.path);
		if (targetEl) {
			targetEl.addClass("is-kb-active");
			targetEl.scrollIntoView({ block: "nearest" });
		}
	}

	private iconBtn(
		parent: HTMLElement,
		icon: string,
		title: string,
		onClick: (e: MouseEvent) => void,
		opts: { active?: boolean; primary?: boolean } = {}
	): HTMLButtonElement {
		const btn = parent.createEl("button", {
			cls:
				"my-sc-icon-btn" +
				(opts.active ? " is-active" : "") +
				(opts.primary ? " is-primary" : ""),
			attr: { type: "button", title, "aria-label": title },
		});
		setIcon(btn, icon);
		btn.onclick = onClick;
		return btn;
	}

	private hasOpenBranches(branchPath: string): boolean {
		for (const p of collectDescendants(branchPath, this.scan)) {
			if (this.expanded.has(p) && (this.scan.childrenOf.get(p)?.length ?? 0) > 0) {
				return true;
			}
		}
		return false;
	}

	private syncExpandToggle(): void {
		const btn = this.expandToggleBtn;
		if (!btn || !btn.isConnected) return;
		const root = this.getRootInCurrentGroup();
		if (!root) return;
		const branch = this.getActiveBranchRoot(root);
		const open = this.hasOpenBranches(branch.path);
		const title = open ? "Свернуть все ветки" : "Развернуть все ветки";
		btn.empty();
		setIcon(btn, open ? "chevrons-down-up" : "chevrons-up-down");
		btn.setAttribute("title", title);
		btn.setAttribute("aria-label", title);
	}

	private openProjectMenu(e: MouseEvent, root: StudyNoteItem, branchRoot: StudyNoteItem): void {
		const menu = new Menu();
		menu.addItem((mi) =>
			mi
				.setTitle(
					branchRoot.path === root.path
						? "Открыть заметку проекта"
						: "Открыть заметку ветки"
				)
				.setIcon("file-text")
				.onClick(() => this.openNote(branchRoot.path))
		);
		menu.addItem((mi) =>
			mi
				.setTitle("Открыть схему / холст проекта")
				.setIcon("image")
				.onClick(() => this.openSchemaForNode(branchRoot.path))
		);
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle("Открыть конструктор в новой вкладке")
				.setIcon("file-plus")
				.onClick(() => {
					void this.plugin.openCompiler({
						rootPath: root.path,
						schemaNotePath: this.schemaNotePath,
						viewMode: this.viewMode,
						location: "tab",
					});
				})
		);
		menu.addItem((mi) =>
			mi
				.setTitle("Открыть конструктор в боковой панели")
				.setIcon("panel-right")
				.onClick(() => {
					void this.plugin.openCompiler({
						rootPath: root.path,
						schemaNotePath: this.schemaNotePath,
						viewMode: this.viewMode,
						location: "sidebar",
					});
				})
		);
		menu.addItem((mi) =>
			mi
				.setTitle("Открыть конструктор в отдельном окне")
				.setIcon("external-link")
				.onClick(() => {
					void this.plugin.openCompiler({
						rootPath: root.path,
						schemaNotePath: this.schemaNotePath,
						viewMode: this.viewMode,
						location: "window",
					});
				})
		);
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle(root.isCompletedRoot ? "Вернуть проект в работу" : "Завершить проект")
				.setIcon(root.isCompletedRoot ? "rotate-ccw" : "check")
				.onClick(() => void this.toggleRootProjectStatus(root))
		);
		menu.showAtMouseEvent(e);
	}

	private renderBar(): void {
		this.barEl.empty();
		this.expandToggleBtn = null;
		this.focusModeBtn = null;
		this.fullscreenBtn = null;
		this.workSelectEl = null;

		const root = this.resolveRootWithFallback();
		if (!root) {
			this.formEl.empty();
			this.barEl.createDiv({
				cls: "my-sc-empty-group-box",
				text: `Проектов пока нет. Создай заметку с направлением «${this.plugin.settings.studyAreaName}» без родителя.`,
			});
			return;
		}

		const branchRoot = this.getActiveBranchRoot(root);

		const topRow = this.barEl.createDiv("my-sc-top-row");
		const sel = topRow.createEl("select", { cls: "dropdown my-sc-work-select" });
		this.workSelectEl = sel;

const addGroup = (label: string, list: StudyNoteItem[]) => {
			if (list.length === 0) return;
			const group = sel.createEl("optgroup", {
				attr: { label: `${label} · ${list.length}` },
			});
			for (const r of list) {
				const meta = getWorkMeta(r.noteType, r.icon);
				const o = group.createEl("option", {
					text: `${meta.icon} ${r.name}`,
					value: r.path,
				});
				if (r.path === root.path) o.selected = true;
			}
		};
		addGroup("Активные", this.scan.activeRoots);
		addGroup("Завершённые", this.scan.completedRoots);

		sel.onchange = () => {
			const picked = this.scan.roots.find((r) => r.path === sel.value);
			if (!picked) return;
			this.groupTab = picked.isCompletedRoot ? "completed" : "active";
			this.plugin.settings.projectGroupTab = this.groupTab;
			this.selectedPath = picked.path;
			this.schemaNotePath = picked.path;
			this.activeCanvasKey = "";
			this.savedSchemaCamera = null;
			this.savedGraphCamera = null;
			this.plugin.settings.lastWorkPath = picked.path;
			this.focusBranchPath =
				this.plugin.settings.focusedBranchByWork[picked.path] || "";
			this.plugin.requestSaveSettings();
			this.form.open = false;
			this.formEl.empty();
			this.activeRowIndex = -1;
			this.renderBar();
			this.renderBreadcrumbs();
			this.renderMain();
			this.focusSafeContainer();
			this.requestSaveViewState();
		};

		const topActions = topRow.createDiv("my-sc-top-actions");

		const modeSeg = topActions.createDiv("my-sc-view-seg");
		const addModeBtn = (mode: ViewMode, icon: string, label: string, hint: string) => {
			const b = modeSeg.createEl("button", {
				cls: "my-sc-view-seg-btn" + (this.viewMode === mode ? " is-active" : ""),
				attr: {
					type: "button",
					title: hint,
					"aria-pressed": String(this.viewMode === mode),
				},
			});
			const icSpan = b.createSpan("my-sc-view-seg-icon");
			setIcon(icSpan, icon);
			b.createSpan({ cls: "my-sc-view-seg-label", text: label });
			b.onclick = () => this.setViewMode(mode);
		};
		addModeBtn("tree", "list", "Дерево", "Иерархическое дерево проекта");
		addModeBtn("graph", "network", "Граф", "Силовой граф связей проекта");
		addModeBtn(
			"schema",
			"image",
			"Схема",
			"Редактор схем и аннотаций поверх картинок"
		);

		if (this.viewMode === "tree") {
			this.expandToggleBtn = this.iconBtn(
				topActions,
				"chevrons-up-down",
				"Развернуть все ветки",
				() => {
					const open = this.hasOpenBranches(branchRoot.path);
					for (const p of collectDescendants(branchRoot.path, this.scan)) {
						if (open) this.expanded.delete(p);
						else if ((this.scan.childrenOf.get(p)?.length ?? 0) > 0)
							this.expanded.add(p);
					}
					this.saveExpanded();
					this.renderTree();
					this.focusSafeContainer();
				}
			);
			this.syncExpandToggle();
		}

		this.iconBtn(
			topActions,
			this.form.open ? "x" : "plus",
			this.form.open ? "Закрыть форму" : "Добавить материал",
			() => {
				if (this.form.open) {
					this.form.open = false;
					this.formEl.empty();
					this.renderBar();
					this.focusSafeContainer();
				} else {
					this.openForm(branchRoot.path, true);
				}
			},
			{ primary: true, active: this.form.open }
		);

		topActions.createSpan("my-sc-top-divider");

		this.iconBtn(
			topActions,
			"external-link",
			"Открыть в отдельном окне (popout)",
			() => {
				void this.plugin.openCompiler({
					rootPath: root.path,
					schemaNotePath: this.schemaNotePath || branchRoot.path,
					activeCanvasKey:
						this.schemaView?.getActiveSlideKey() || this.activeCanvasKey,
					viewMode: this.viewMode,
					location: "window",
				});
			}
		);

		this.focusModeBtn = this.iconBtn(
			topActions,
			"panel-top-close",
			"Сфокусировать рабочую область (скрыть шапку)",
			() => this.toggleFocusMode(),
			{ active: this.isFocusMode }
		);

		this.fullscreenBtn = this.iconBtn(
			topActions,
			"maximize-2",
			"Полный экран (F11)",
			() => void this.toggleFullscreen()
		);
		this.syncFullscreenButtonState();

		this.iconBtn(topActions, "more-horizontal", "Действия с проектом", (e) =>
			this.openProjectMenu(e, root, branchRoot)
		);
	}

	private async toggleRootProjectStatus(root: StudyNoteItem): Promise<void> {
		const nextDone = !root.isCompletedRoot;
		try {
			await this.app.fileManager.processFrontMatter(
				root.file,
				(fm: Record<string, unknown>) => {
					fm[KEYS.status] = nextDone ? ROOT_STATUS_DONE : ROOT_STATUS_ACTIVE;
					if (nextDone && !fm[KEYS.finishedAt]) {
						fm[KEYS.finishedAt] = todayISO();
					}
				}
			);
			this.groupTab = nextDone ? "completed" : "active";
			this.plugin.settings.projectGroupTab = this.groupTab;
			this.plugin.requestSaveSettings();
			new Notice(
				nextDone
					? `Проект «${root.name}» перенесён в завершённые`
					: `Проект «${root.name}» возвращён в активные`
			);
		} catch (err: unknown) {
			new Notice(
				"Не удалось изменить статус проекта: " +
					(err instanceof Error ? err.message : String(err))
			);
		}
	}

	private renderSearchPanel(): void {
		this.searchWrapEl.empty();

		const inp = this.searchWrapEl.createEl("input", {
			cls: "my-sc-search-input",
			attr: {
				type: "search",
				placeholder: "Название, тип или #тег",
			},
		});
		inp.value = this.searchQuery;
		this.searchInputEl = inp;
		inp.oninput = () => {
			this.searchQuery = inp.value;
			this.activeRowIndex = 0;
			this.renderTree();
		};

		const orphanCount = this.scan.orphans.length;
		if (orphanCount > 0 || this.filterMode === "orphans") {
			const chip = this.searchWrapEl.createEl("button", {
				cls:
					"my-sc-filter-chip" +
					(this.filterMode === "orphans" ? " is-active" : ""),
				text: `Без родителя · ${orphanCount}`,
				attr: {
					type: "button",
					title: "Показать материалы, не привязанные к дереву",
				},
			});
			chip.onclick = () => {
				this.filterMode = this.filterMode === "orphans" ? "all" : "orphans";
				this.activeRowIndex = -1;
				this.renderSearchPanel();
				this.renderTree();
				this.focusSafeContainer();
			};
		}
	}

	private renderBreadcrumbs(): void {
		this.crumbsEl.empty();
		if (this.viewMode === "schema") {
			this.crumbsEl.addClass("is-hidden");
			return;
		}
		const root = this.getRootInCurrentGroup();
		if (!root) {
			this.crumbsEl.addClass("is-hidden");
			return;
		}
		const branchRoot = this.getActiveBranchRoot(root);
		if (branchRoot.path === root.path) {
			this.crumbsEl.addClass("is-hidden");
			return;
		}
		this.crumbsEl.removeClass("is-hidden");

		const chain = buildBreadcrumbChain(this.scan, root.path, branchRoot.path);

		chain.forEach((node, idx) => {
			if (idx > 0) {
				this.crumbsEl.createSpan({ cls: "my-sc-crumb-sep", text: "›" });
			}
			const isLast = idx === chain.length - 1;
const btn = this.crumbsEl.createEl("button", {
				cls: "my-sc-crumb-btn" + (isLast ? " is-current" : ""),
				text: node.name,
				attr: { type: "button" },
			});
			btn.onclick = () => this.setFocusBranch(root, node.path);
			this.bindDropTarget(btn, node);
		});

		const resetBtn = this.crumbsEl.createEl("button", {
			cls: "my-sc-crumb-reset",
			text: "Весь проект",
			attr: { type: "button", title: "Вернуться ко всему дереву проекта" },
		});
		resetBtn.onclick = () => this.setFocusBranch(root, root.path);
	}

	private openForm(parentPath: string, focusTitle = true): void {
		const root = this.getRootInCurrentGroup();
		if (!root) return;
		this.form.open = true;
		this.form.type =
			this.plugin.settings.lastUsedMaterialType ||
			this.scan.schema.typeCounts[0]?.name ||
			"Термин";
		this.form.parentPath = this.scan.byPath.has(parentPath) ? parentPath : root.path;
		this.renderBar();
		this.renderForm(focusTitle);
		this.formEl.querySelector(".my-sc-add-box")?.addClass("is-entering");
	}

	private renderForm(focusTitle = false): void {
		this.formEl.empty();
		if (!this.form.open) return;
		const root = this.getRootInCurrentGroup();
		if (!root) return;

		const box = this.formEl.createDiv("my-sc-add-box");
		const topRow = box.createDiv("my-sc-form-row");

		const typeWrap = topRow.createDiv("my-sc-type-input-wrap");
		const typeInp = typeWrap.createEl("input", {
			cls: "my-sc-type-input",
			attr: {
				type: "text",
				list: "my-sc-types-datalist",
				placeholder: "Тип (Термин, Расчёт, Схема…)",
				title: "Впиши любой тип или выбери из подсказок",
			},
		});
		typeInp.value = this.form.type;

		const caseHintEl = box.createDiv("my-sc-case-hint is-hidden");

		const updateCaseHint = () => {
			const existingCase = findCaseInsensitiveTypeMatch(
				typeInp.value,
				this.scan.schema.typeCounts
			);
			caseHintEl.empty();
			if (!existingCase) {
				caseHintEl.addClass("is-hidden");
				return;
			}
			caseHintEl.removeClass("is-hidden");
			caseHintEl.createSpan({
				text: `В базе уже есть тип «${existingCase}». `,
			});
			const useExistingBtn = caseHintEl.createEl("button", {
				cls: "my-sc-inline-link-btn",
				text: `Использовать «${existingCase}»`,
				attr: { type: "button" },
			});
			useExistingBtn.onclick = () => {
				this.form.type = existingCase;
				typeInp.value = existingCase;
				caseHintEl.addClass("is-hidden");
			};
		};

		typeInp.oninput = () => {
			this.form.type = typeInp.value;
			updateCaseHint();
		};
		updateCaseHint();

		const titleInp = topRow.createEl("input", {
			cls: "my-sc-input",
			attr: { type: "text", placeholder: "Название темы или материала…" },
		});
		titleInp.value = this.form.title;
		titleInp.oninput = () => {
			this.form.title = titleInp.value;
		};

		const parentSel = topRow.createEl("select", {
			cls: "dropdown my-sc-parent-select",
		});
		parentSel.createEl("option", { text: `↳ ${root.name}`, value: root.path });
		const allTree = buildNestedFilteredTree(root, this.scan, null, {
			query: "",
			mode: "all",
			typeFilter: "",
		});
		for (const n of flattenVisibleTree(allTree)) {
			parentSel.createEl("option", {
				text: `${"\u00A0\u00A0".repeat(n.depth + 1)}↳ ${n.item.name}`,
				value: n.item.path,
			});
		}
		parentSel.value = this.form.parentPath;
		if (parentSel.value !== this.form.parentPath) {
			this.form.parentPath = root.path;
			parentSel.value = root.path;
		}
		parentSel.onchange = () => {
			this.form.parentPath = parentSel.value;
		};

		const dateInp = topRow.createEl("input", {
			cls: "my-sc-date",
			attr: { type: "date", title: "Дедлайн (необязательно)" },
		});
		dateInp.value = this.form.deadline;
		dateInp.onchange = () => {
			this.form.deadline = dateInp.value;
		};

		if (this.scan.schema.typeCounts.length > 0) {
			const quickTypesRow = box.createDiv("my-sc-quick-types-row");
			quickTypesRow.createSpan({
				cls: "my-sc-quick-types-label",
				text: "Частые типы:",
			});
			for (const tc of this.scan.schema.typeCounts.slice(0, 7)) {
				const chip = quickTypesRow.createEl("button", {
					cls:
						"my-sc-filter-chip" +
						(normalizeSpaces(this.form.type).toLowerCase() ===
						tc.name.toLowerCase()
							? " is-active"
							: ""),
					text: `${tc.name} (${tc.count})`,
					attr: { type: "button" },
				});
				chip.onclick = () => {
					this.form.type = tc.name;
					this.renderForm(false);
				};
			}
		}

		const propsSection = box.createDiv("my-sc-props-section");
		for (let i = 0; i < this.form.customProps.length; i++) {
			const draft = this.form.customProps[i];
			if (!draft) continue;
			const pRow = propsSection.createDiv("my-sc-prop-row");
			const valDatalistId = `my-sc-val-dl-${draft.id}`;

			const keyInp = pRow.createEl("input", {
				cls: "my-sc-prop-key",
				attr: {
					type: "text",
					list: "my-sc-prop-keys-datalist",
					placeholder: "Ключ (напр. источник, автор)…",
				},
			});
			keyInp.value = draft.key;

			const valDl = pRow.createEl("datalist", { attr: { id: valDatalistId } });
			const populateValSuggestions = (kName: string) => {
				valDl.empty();
				const vals =
					this.scan.schema.valuesByKey.get(normalizeSpaces(kName)) ?? [];
				for (const v of vals.slice(0, 25)) {
					valDl.createEl("option", { attr: { value: v } });
				}
			};
			populateValSuggestions(draft.key);

			keyInp.oninput = () => {
				draft.key = keyInp.value;
				populateValSuggestions(draft.key);
			};

			const valInp = pRow.createEl("input", {
				cls: "my-sc-prop-val",
				attr: {
					type: "text",
					list: valDatalistId,
					placeholder:
						draft.kind === "list"
							? "Значения через запятую…"
							: "Значение (дата ГГГГ-ММ-ДД, число или текст)…",
				},
			});
			valInp.value = draft.value;
			valInp.oninput = () => {
				draft.value = valInp.value;
			};

			const kindSel = pRow.createEl("select", {
				cls: "dropdown my-sc-prop-kind",
				attr: { title: "Формат записи в YAML" },
			});
			kindSel.createEl("option", { text: "Значение", value: "auto" });
			kindSel.createEl("option", { text: "Список (,)", value: "list" });
			kindSel.value = draft.kind;
			kindSel.onchange = () => {
				draft.kind = kindSel.value === "list" ? "list" : "auto";
				valInp.placeholder =
					draft.kind === "list"
						? "Значения через запятую…"
						: "Значение (дата ГГГГ-ММ-ДД, число или текст)…";
			};

			this.iconBtn(pRow, "x", "Удалить свойство", () => {
				this.form.customProps.splice(i, 1);
				this.renderForm(false);
			});
		}

		const actionsRow = box.createDiv("my-sc-form-actions");
		const addPropBtn = actionsRow.createEl("button", {
			cls: "my-sc-chip-btn",
			text: "Добавить свойство",
			attr: { type: "button" },
		});
		addPropBtn.onclick = () => {
			this.form.customProps.push({
				id: String(Date.now() + Math.random()),
				key: "",
				value: "",
				kind: "auto",
			});
			this.renderForm(false);
		};

		const createBtn = actionsRow.createEl("button", {
			cls: "mod-cta my-sc-action-btn",
			text: "Создать материал",
			attr: { type: "button" },
		});

		const submit = async () => {
			createBtn.disabled = true;
			const ok = await this.createNote(root);
			if (ok) {
				this.form.title = "";
				this.form.deadline = "";
				this.form.customProps = [];
				this.renderForm(true);
			} else {
				createBtn.disabled = false;
			}
		};
		createBtn.onclick = () => void submit();
		titleInp.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.isComposing) void submit();
		});
		if (focusTitle) {
			this.win.setTimeout(() => titleInp.focus(), 20);
		}
	}

	private async createNote(root: StudyNoteItem): Promise<boolean> {
		const cleanTitle = normalizeSpaces(this.form.title).replace(/[\\/:*?"<>|]/g, "");
		if (!cleanTitle) {
			new Notice("Введи название материала.");
			return false;
		}

		const normalizedType = normalizeSpaces(this.form.type) || "Материал";

		const seenKeysLower = new Set<string>([
			KEYS.area.toLowerCase(),
			KEYS.type.toLowerCase(),
			KEYS.parent.toLowerCase(),
		]);
		if (root.discipline) seenKeysLower.add(KEYS.discipline.toLowerCase());
		if (/^\d{4}-\d{2}-\d{2}$/.test(this.form.deadline)) {
			seenKeysLower.add(KEYS.deadline.toLowerCase());
		}

		const preparedProps: Array<{ key: string; serialized: string }> = [];

		for (const draft of this.form.customProps) {
			const k = normalizeSpaces(draft.key);
			const parsedVal = parseCustomPropertyValue(draft.value, draft.kind);
			if (!k && parsedVal === undefined) continue;
			if (!k) {
				new Notice(
					"Укажи имя ключа для добавленного свойства или удали пустую строку."
				);
				return false;
			}
			if (isReservedYamlKey(k)) {
				new Notice(
					`Ключ «${k}» задаётся основными полями формы. Удали его из дополнительных свойств.`
				);
				return false;
			}
			const kLow = k.toLowerCase();
			if (seenKeysLower.has(kLow)) {
				new Notice(
					`Дублирующийся ключ свойства «${k}». Оставь только одно поле.`
				);
				return false;
			}
			if (parsedVal === undefined) continue;

			seenKeysLower.add(kLow);
			preparedProps.push({
				key: k,
				serialized: serializeYamlScalarOrList(parsedVal),
			});
		}

		const folder = normalizePath(this.plugin.settings.newNoteFolder || "Знания");
		const targetPath = normalizePath(`${folder}/${cleanTitle}.md`);
		if (this.app.vault.getAbstractFileByPath(targetPath)) {
			new Notice(`Заметка «${cleanTitle}» уже есть в папке ${folder}.`);
			return false;
		}
		const parent = this.scan.byPath.get(this.form.parentPath) ?? root;

		try {
			await ensureFolder(this.app, folder);
			const link = this.app.metadataCache.fileToLinktext(parent.file, targetPath);
			const lines = [
				"---",
				`${KEYS.area}: ${JSON.stringify(this.plugin.settings.studyAreaName)}`,
				`${KEYS.type}: ${JSON.stringify(normalizedType)}`,
				`${KEYS.parent}: ${JSON.stringify(`[[${link}]]`)}`,
			];
			if (root.discipline) {
				lines.push(`${KEYS.discipline}: ${JSON.stringify(root.discipline)}`);
			}
			if (/^\d{4}-\d{2}-\d{2}$/.test(this.form.deadline)) {
				lines.push(`${KEYS.deadline}: ${JSON.stringify(this.form.deadline)}`);
			}
			for (const prop of preparedProps) {
				lines.push(`${prop.key}: ${prop.serialized}`);
			}
			lines.push("---", "", `# ${cleanTitle}`, "", "");
			await this.app.vault.create(targetPath, lines.join("\n"));

			this.plugin.settings.lastUsedMaterialType = normalizedType;
			this.expanded.add(parent.path);
			this.saveExpanded();
			new Notice(`Создано: «${cleanTitle}» (${normalizedType})`);
			return true;
		} catch (err: unknown) {
			new Notice(
				"Ошибка создания: " + (err instanceof Error ? err.message : String(err))
			);
			return false;
		}
	}

	private renderDeadline(parent: HTMLElement, item: StudyNoteItem): void {
		if (!item.deadline) return;
		const tone = getDeadlineTone(item);
		const cls =
			tone === "overdue"
				? " is-overdue"
				: tone === "soon"
					? " is-soon"
					: " is-far";
		parent.createSpan({
			cls: "my-sc-deadline" + cls,
			text: formatDeadlineBadge(item),
			attr: {
				title: formatFullDateTooltip(item.deadline),
			},
		});
	}

	private renderHighlightedTitle(
		container: HTMLElement,
		text: string,
		query: string
	): void {
		const cleanQ = query
			.trim()
			.split(/\s+/)
			.filter((t) => !t.startsWith("#"))[0];
		if (!cleanQ) {
			container.setText(text);
			return;
		}
		const lowerText = text.toLowerCase();
		const lowerQ = cleanQ.toLowerCase();
		const idx = lowerText.indexOf(lowerQ);
		if (idx === -1) {
			container.setText(text);
			return;
		}
		if (idx > 0) container.appendText(text.slice(0, idx));
		container.createEl("mark", {
			cls: "my-sc-hl",
			text: text.slice(idx, idx + cleanQ.length),
		});
		if (idx + cleanQ.length < text.length) {
			container.appendText(text.slice(idx + cleanQ.length));
		}
	}

	private openNote(path: string, newTab = false): void {
		void this.plugin.openNoteFromCompiler(path, newTab, this.leaf);
	}

	private startNodeEditing(path: string, mode: "type" | "props"): void {
		this.editingNodePath = path;
		this.editingNodeMode = mode;
		this.renderTree();
	}

	private openRowMenu(
		e: MouseEvent,
		item: StudyNoteItem,
		projectRoot: StudyNoteItem
	): void {
		const menu = new Menu();
		menu.addItem((mi) =>
			mi
				.setTitle("Открыть заметку")
				.setIcon("file-text")
				.onClick(() => this.openNote(item.path, false))
		);
		menu.addItem((mi) =>
			mi
				.setTitle("Открыть заметку в новой вкладке")
				.setIcon("file-plus")
				.onClick(() => this.openNote(item.path, true))
		);
		menu.addItem((mi) =>
			mi
				.setTitle("Открыть схему / аннотации")
				.setIcon("image")
				.onClick(() => this.openSchemaForNode(item.path))
		);
		menu.addItem((mi) =>
			mi
				.setTitle("Фокус на этой ветке")
				.setIcon("crosshair")
				.onClick(() => this.setFocusBranch(projectRoot, item.path))
		);
		menu.addItem((mi) =>
			mi
				.setTitle("Добавить материал внутрь")
				.setIcon("plus")
				.onClick(() => this.openForm(item.path, true))
		);
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle("Изменить тип")
				.setIcon("tag")
				.onClick(() => this.startNodeEditing(item.path, "type"))
		);
		menu.addItem((mi) =>
			mi
				.setTitle("Свойство YAML…")
				.setIcon("settings")
				.onClick(() => this.startNodeEditing(item.path, "props"))
		);
		menu.addItem((mi) =>
			mi
				.setTitle("Сменить родителя…")
				.setIcon("arrow-left-right")
				.onClick(() => this.openMovePicker(item))
		);
		menu.showAtMouseEvent(e);
	}

	private renderTree(): void {
		const scrollTop = this.treeEl.scrollTop;
		this.treeEl.empty();
		this.rowElementByPath.clear();
		const root = this.getRootInCurrentGroup();
		if (!root) return;

		const branchRoot = this.getActiveBranchRoot(root);
		const nestedNodes = buildNestedFilteredTree(
			branchRoot,
			this.scan,
			this.expanded,
			{
				query: this.searchQuery,
				mode: this.filterMode,
				typeFilter: this.typeFilter,
			}
		);
		this.currentVisibleFlat = flattenVisibleTree(nestedNodes);

		if (nestedNodes.length === 0) {
			const hasFilters =
				this.searchQuery.trim().length > 0 ||
				this.filterMode !== "all" ||
				this.typeFilter.length > 0;
			this.treeEl.createDiv({
				cls: "my-sc-empty",
				text: hasFilters
					? "Ничего не найдено."
					: "Здесь пока пусто. Добавь материал кнопкой «+».",
			});
			this.pendingOpenPath = null;
			this.syncExpandToggle();
			return;
		}

		const listEl = this.treeEl.createDiv("my-sc-tree-list");
		for (const node of nestedNodes) {
			this.renderNodeGroup(listEl, node, root);
		}

		if (this.activeRowIndex >= 0) {
			this.highlightActiveRow();
		}
		this.treeEl.scrollTop = scrollTop;

		if (this.pendingOpenPath) {
			const openPath = this.pendingOpenPath;
			this.pendingOpenPath = null;
			const kids = this.getChildrenContainer(openPath);
			if (kids) animateOpen(kids);
			if (!prefersReducedMotion()) {
				const btn = this.rowElementByPath
					.get(openPath)
					?.querySelector<HTMLElement>(".my-sc-toggle-btn");
				if (btn) {
					btn.removeClass("is-open");
					void btn.offsetWidth;
					btn.addClass("is-open");
				}
			}
		}

		this.syncExpandToggle();
	}

	private renderNodeGroup(
		parentContainer: HTMLElement,
		node: TreeNode,
		projectRoot: StudyNoteItem
	): void {
		const item = node.item;
		const depthSlot = node.depth % 5;

		const groupEl = parentContainer.createDiv({
			cls:
				"my-sc-node-group" +
				` is-depth-${depthSlot}` +
				(node.hasChildren ? " is-branch" : " is-leaf") +
				(node.isExpanded ? " is-expanded" : " is-collapsed"),
		});

const row = groupEl.createDiv({
			cls:
				"my-sc-tree-row" +
				(node.hasChildren ? " is-parent-row" : "") +
				(node.isExpanded ? " is-open-parent" : "") +
				(node.isDirectMatch ? " is-match" : "") +
				(this.freshPaths.has(item.path) ? " is-new" : ""),
			attr: { draggable: "true" },
		});
		this.rowElementByPath.set(item.path, row);
		row.oncontextmenu = (e) => {
			e.preventDefault();
			this.openRowMenu(e, item, projectRoot);
		};
		row.addEventListener("dragstart", (e: DragEvent) => {
			this.draggedNodePath = item.path;
			row.addClass("is-dragging");
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", item.path);
			}
		});
		row.addEventListener("dragend", () => {
			this.draggedNodePath = null;
			row.removeClass("is-dragging");
		});
		this.bindDropTarget(row, item);

		const left = row.createDiv("my-sc-tree-left");

		if (node.hasChildren) {
			const toggleBtn = left.createEl("button", {
				cls: "my-sc-toggle-btn" + (node.isExpanded ? " is-open" : ""),
				attr: {
					type: "button",
					title: node.isExpanded ? "Свернуть ветку" : "Развернуть ветку",
					"aria-label": node.isExpanded ? "Свернуть ветку" : "Развернуть ветку",
					"aria-expanded": String(node.isExpanded),
				},
			});
			setIcon(toggleBtn, "chevron-right");
			toggleBtn.onclick = (e) => {
				e.stopPropagation();
				this.toggleBranch(item.path);
			};
		} else {
			const dotWrap = left.createSpan("my-sc-leaf-marker");
			dotWrap.createSpan("my-sc-leaf-dot");
		}

const title = left.createSpan({
			cls: "my-sc-node-title",
			attr: { title: `${item.name} (${item.path})` },
		});
		this.renderHighlightedTitle(title, item.name, this.searchQuery);
		title.onclick = (e) => this.openNote(item.path, e.ctrlKey || e.metaKey);
		title.addEventListener("mouseenter", (e: MouseEvent) => {
			this.triggerHoverPreview(e, title, item.path);
		});

		if (item.parentPaths.length > 1) {
			left.createSpan({
				cls: "my-sc-multi-parent",
				text: `×${item.parentPaths.length}`,
				attr: { title: `Привязана к ${item.parentPaths.length} родителям` },
			});
		}

		const right = row.createDiv("my-sc-tree-right");
		this.renderDeadline(right, item);

		if (item.mediaItems.length > 0 || item.annotationCount > 0) {
			const mediaPill = right.createEl("button", {
				cls: "my-sc-media-pill",
				text:
					item.annotationCount > 0
						? `☊ ${item.annotationCount}`
						: `🖼 ${item.mediaItems.length}`,
				attr: {
					type: "button",
					title: `Открыть схему «${item.name}» (картинок: ${item.mediaItems.length}, аннотаций: ${item.annotationCount})`,
				},
			});
			mediaPill.onclick = (e) => {
				e.stopPropagation();
				this.openSchemaForNode(item.path);
			};
		}

		const meta = getWorkMeta(item.noteType, item.icon);
		const kind = right.createEl("button", {
			cls: "my-sc-type-badge",
			attr: {
				type: "button",
				title: `${item.noteType || "Без типа"} · нажми, чтобы изменить`,
			},
		});
		kind.createSpan({ cls: "my-sc-type-icon", text: meta.icon });
		kind.createSpan({ cls: "my-sc-type-name", text: item.noteType || "без типа" });
		kind.style.setProperty("--badge-color", meta.color);
		kind.onclick = (e) => {
			e.stopPropagation();
			if (this.editingNodePath === item.path && this.editingNodeMode === "type") {
				this.editingNodePath = null;
				this.editingNodeMode = null;
				this.renderTree();
			} else {
				this.startNodeEditing(item.path, "type");
			}
		};

		if (node.hasChildren) {
			const countPill = right.createEl("button", {
				cls:
					"my-sc-subcount-pill" +
					(node.isExpanded ? " is-expanded" : " is-collapsed"),
				text: `${node.descendantCount}`,
				attr: {
					type: "button",
					title: node.isExpanded
						? `Вложено: ${node.descendantCount} (нажми, чтобы свернуть)`
						: `Скрыто вложенных: ${node.descendantCount} (нажми, чтобы раскрыть)`,
				},
			});
			countPill.onclick = (e) => {
				e.stopPropagation();
				this.toggleBranch(item.path);
			};
		}

		const moreBtn = right.createEl("button", {
			cls: "my-sc-row-more",
			attr: {
				type: "button",
				title: "Действия",
				"aria-label": "Действия с материалом",
			},
		});
		setIcon(moreBtn, "more-horizontal");
		moreBtn.onclick = (e) => {
			e.stopPropagation();
			this.openRowMenu(e, item, projectRoot);
		};

		if (this.editingNodePath === item.path && this.editingNodeMode) {
			this.renderInlineNodeEditor(groupEl, item);
		}

		if (node.isExpanded && node.children.length > 0) {
			const childrenWrap = groupEl.createDiv("my-sc-children-container");
			for (const child of node.children) {
				this.renderNodeGroup(childrenWrap, child, projectRoot);
			}
		}
	}

	private renderInlineNodeEditor(
		parentGroup: HTMLElement,
		item: StudyNoteItem
	): void {
		const editorBox = parentGroup.createDiv("my-sc-inline-editor");

		if (this.editingNodeMode === "type") {
			editorBox.createSpan({ cls: "my-sc-inline-label", text: "Тип:" });
			const inp = editorBox.createEl("input", {
				cls: "my-sc-type-input",
				attr: {
					type: "text",
					list: "my-sc-types-datalist",
					value: item.noteType,
					placeholder: "Новый тип…",
				},
			});
			const saveBtn = editorBox.createEl("button", {
				cls: "mod-cta my-sc-chip-btn",
				text: "Сохранить",
				attr: { type: "button" },
			});
			const cancelBtn = editorBox.createEl("button", {
				cls: "my-sc-chip-btn",
				text: "Отмена",
				attr: { type: "button" },
			});

			const applyType = async () => {
				const nextType = normalizeSpaces(inp.value);
				if (!nextType) {
					new Notice("Введи название типа.");
					return;
				}
				try {
					await this.app.fileManager.processFrontMatter(
						item.file,
						(fm: Record<string, unknown>) => {
							fm[KEYS.type] = nextType;
						}
					);
					this.plugin.settings.lastUsedMaterialType = nextType;
					this.plugin.requestSaveSettings();
					this.editingNodePath = null;
					this.editingNodeMode = null;
					new Notice(`Тип «${item.name}» → ${nextType}`);
				} catch (err: unknown) {
					new Notice(
						"Ошибка записи YAML: " +
							(err instanceof Error ? err.message : String(err))
					);
				}
			};

			saveBtn.onclick = () => void applyType();
			cancelBtn.onclick = () => {
				this.editingNodePath = null;
				this.editingNodeMode = null;
				this.renderTree();
				this.focusSafeContainer();
			};
			inp.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Enter") void applyType();
			});
			this.win.setTimeout(() => inp.focus(), 20);
			return;
		}

		editorBox.createSpan({ cls: "my-sc-inline-label", text: "Свойство YAML:" });
		const dlId = `my-sc-inline-val-${Date.now()}`;
		const keyInp = editorBox.createEl("input", {
			cls: "my-sc-prop-key",
			attr: {
				type: "text",
				list: "my-sc-prop-keys-datalist",
				placeholder: "Ключ (напр. источник)…",
			},
		});
		const valDl = editorBox.createEl("datalist", { attr: { id: dlId } });
		keyInp.oninput = () => {
			valDl.empty();
			const vals =
				this.scan.schema.valuesByKey.get(normalizeSpaces(keyInp.value)) ?? [];
			for (const v of vals.slice(0, 25)) {
				valDl.createEl("option", { attr: { value: v } });
			}
		};

		const valInp = editorBox.createEl("input", {
			cls: "my-sc-prop-val",
			attr: {
				type: "text",
				list: dlId,
				placeholder: "Значение (пусто = удалить ключ)…",
			},
		});

		const kindSel = editorBox.createEl("select", {
			cls: "dropdown my-sc-prop-kind",
		});
		kindSel.createEl("option", { text: "Значение", value: "auto" });
		kindSel.createEl("option", { text: "Список (,)", value: "list" });

		const saveBtn = editorBox.createEl("button", {
			cls: "mod-cta my-sc-chip-btn",
			text: "Записать",
			attr: { type: "button" },
		});
		const cancelBtn = editorBox.createEl("button", {
			cls: "my-sc-chip-btn",
			text: "Отмена",
			attr: { type: "button" },
		});

		const applyProp = async () => {
			const k = normalizeSpaces(keyInp.value);
			if (!k) {
				new Notice("Укажи ключ свойства.");
				return;
			}
			if (isReservedYamlKey(k)) {
				new Notice(
					`Служебный ключ «${k}» меняется через кнопку типа или смены родителя.`
				);
				return;
			}
			const kind = kindSel.value === "list" ? "list" : "auto";
			const parsedVal = parseCustomPropertyValue(valInp.value, kind);
			try {
				await this.app.fileManager.processFrontMatter(
					item.file,
					(fm: Record<string, unknown>) => {
						if (parsedVal === undefined) {
							delete fm[k];
						} else {
							fm[k] = parsedVal;
						}
					}
				);
				this.editingNodePath = null;
				this.editingNodeMode = null;
				new Notice(
					parsedVal === undefined
						? `Свойство «${k}» удалено из «${item.name}»`
						: `Записано «${k}» в «${item.name}»`
				);
			} catch (err: unknown) {
				new Notice(
					"Ошибка записи YAML: " +
						(err instanceof Error ? err.message : String(err))
				);
			}
		};

		saveBtn.onclick = () => void applyProp();
		cancelBtn.onclick = () => {
			this.editingNodePath = null;
			this.editingNodeMode = null;
			this.renderTree();
			this.focusSafeContainer();
		};
		this.win.setTimeout(() => keyInp.focus(), 20);
	}

private triggerHoverPreview(
		event: MouseEvent,
		targetEl: Element,
		notePath: string
	): void {
		if (!event.ctrlKey && !event.metaKey) return;
		this.app.workspace.trigger("hover-link", {
			event,
			source: VIEW_TYPE_STUDY_COMPILER,
			hoverParent: this,
			targetEl,
			linktext: notePath,
			sourcePath: notePath,
		});
	}

	private canDropNodeOnTarget(sourcePath: string, targetPath: string): boolean {
		if (!sourcePath || !targetPath || sourcePath === targetPath) return false;
		const sourceItem = this.scan.byPath.get(sourcePath);
		if (!sourceItem) return false;
		if (sourceItem.parentPaths.includes(targetPath)) return false;
		const forbidden = collectDescendants(sourcePath, this.scan);
		return !forbidden.has(targetPath);
	}

	private bindDropTarget(el: HTMLElement, targetItem: StudyNoteItem): void {
		el.addEventListener("dragover", (e: DragEvent) => {
			const srcPath = this.draggedNodePath;
			if (!srcPath || !this.canDropNodeOnTarget(srcPath, targetItem.path)) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			el.addClass("is-drop-target");
		});
		el.addEventListener("dragleave", () => {
			el.removeClass("is-drop-target");
		});
		el.addEventListener("drop", (e: DragEvent) => {
			el.removeClass("is-drop-target");
			const srcPath =
				this.draggedNodePath || e.dataTransfer?.getData("text/plain") || "";
			this.draggedNodePath = null;
			if (!srcPath || !this.canDropNodeOnTarget(srcPath, targetItem.path)) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const sourceItem = this.scan.byPath.get(srcPath);
			if (sourceItem) {
				void this.setParent(sourceItem, targetItem);
			}
		});
	}

	private openMovePicker(item: StudyNoteItem): void {
		const forbidden = collectDescendants(item.path, this.scan);
		forbidden.add(item.path);
		const candidates = [...this.scan.byPath.values()]
			.filter((c) => !forbidden.has(c.path))
			.sort(byName);
		new ParentPickerModal(this.app, candidates, (target) => {
			void this.setParent(item, target);
		}).open();
	}

	private async setParent(item: StudyNoteItem, target: StudyNoteItem): Promise<void> {
		try {
			const link = this.app.metadataCache.fileToLinktext(target.file, item.path);
			await this.app.fileManager.processFrontMatter(
				item.file,
				(fm: Record<string, unknown>) => {
					fm[KEYS.parent] = `[[${link}]]`;
				}
			);
			this.expanded.add(target.path);
			this.saveExpanded();
			new Notice(`«${item.name}» → «${target.name}»`);
		} catch (err: unknown) {
			new Notice(
				"Не удалось сменить родителя: " +
					(err instanceof Error ? err.message : String(err))
			);
		}
	}
}