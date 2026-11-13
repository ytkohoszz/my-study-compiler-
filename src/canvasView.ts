import { App, FuzzySuggestModal, Modal, Notice, TFile, setIcon } from "obsidian";
import {
	CameraState,
	StudyMediaItem,
	StudyNoteItem,
} from "./types";
import {
	DEFAULT_ELEMENT_STYLE,
	Scene,
	SceneElement,
	SceneFileEntry,
	createEmptyScene,
	generateElementId,
	hashStringSeed,
} from "./scene/types";
import { ScenesByKey, SceneStore } from "./scene/store";
import { CanvasSceneEditor } from "./canvas/editor";
import { MaterialTreeDropdown } from "./ui/material-tree-dropdown";
import {
	cleanWikiTarget,
	extractMediaAndAnnotationMeta,
	IMAGE_EXTENSIONS,
	isExternalImageUrl,
	resolveImageSource,
	saveBinaryImageToVault,
	VIRTUAL_BOARD_KEY,
} from "./media";
import {
	ScanResult,
	buildNestedFilteredTree,
} from "./scanner";

export interface SchemaViewCallbacks {
	onSelectNote: (notePath: string) => void;
	onOpenNote: (notePath: string, newTab?: boolean) => void;
	getMediaFolder: () => string;
	onStateChange?: (activeSlideKey: string, camera: CameraState) => void;
}

interface CanvasImageContext {
	key: string;
	note: StudyNoteItem;
	manager: SceneStore;
	scenes: ScenesByKey;
	editor: CanvasSceneEditor | null;
}

class VaultImagePickerModal extends FuzzySuggestModal<TFile> {
	private onChoose: (file: TFile) => void;

	constructor(app: App, onChoose: (file: TFile) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder("Выбери изображение из хранилища…");
	}

	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((file) => IMAGE_EXTENSIONS.has(file.extension.toLowerCase()));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

class RenameCanvasModal extends Modal {
	private initialName: string;
	private onSubmit: (value: string) => void;

	constructor(app: App, initialName: string, onSubmit: (value: string) => void) {
		super(app);
		this.initialName = initialName;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		this.modalEl.addClass("my-sc-small-dialog");
		this.contentEl.empty();
		this.contentEl.createEl("h4", {
			cls: "my-sc-dialog-title",
			text: "Переименовать холст",
		});
		const input = this.contentEl.createEl("input", {
			cls: "my-sc-input my-sc-dialog-input",
			attr: { type: "text", value: this.initialName },
		});
		const actions = this.contentEl.createDiv("my-sc-dialog-actions");
		const cancel = actions.createEl("button", {
			cls: "my-sc-chip-btn",
			text: "Отмена",
			attr: { type: "button" },
		});
		const save = actions.createEl("button", {
			cls: "mod-cta my-sc-chip-btn",
			text: "Сохранить",
			attr: { type: "button" },
		});
		const submit = () => {
			const value = input.value.trim();
			if (!value) return;
			this.close();
			this.onSubmit(value);
		};
		cancel.onclick = () => this.close();
		save.onclick = submit;
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				submit();
			} else if (event.key === "Escape") {
				event.preventDefault();
				this.close();
			}
		});
		const win = this.contentEl.ownerDocument.defaultView;
		win?.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ConfirmDeleteCanvasModal extends Modal {
	private label: string;
	private onConfirm: () => void;

	constructor(app: App, label: string, onConfirm: () => void) {
		super(app);
		this.label = label;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.modalEl.addClass("my-sc-small-dialog");
		this.contentEl.empty();
		this.contentEl.createEl("h4", {
			cls: "my-sc-dialog-title",
			text: "Удалить холст?",
		});
		this.contentEl.createDiv({
			cls: "my-sc-dialog-desc",
			text: `Холст «${this.label}» и его элементы будут удалены.`,
		});
		const actions = this.contentEl.createDiv("my-sc-dialog-actions");
		const cancel = actions.createEl("button", {
			cls: "my-sc-chip-btn",
			text: "Отмена",
			attr: { type: "button" },
		});
		const remove = actions.createEl("button", {
			cls: "mod-warning my-sc-chip-btn",
			text: "Удалить",
			attr: { type: "button" },
		});
		cancel.onclick = () => this.close();
		remove.onclick = () => {
			this.close();
			this.onConfirm();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function isCanvasImageElement(element: SceneElement): boolean {
	return element.type === "image" && Boolean(element.fileId);
}

function getImageMime(extension: string): string {
	const ext = extension.toLowerCase();
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "svg") return "image/svg+xml";
	if (ext === "gif") return "image/gif";
	if (ext === "webp") return "image/webp";
	if (ext === "bmp") return "image/bmp";
	if (ext === "avif") return "image/avif";
	return "image/png";
}

function cloneSceneForBoard(source: Scene, order: number): Scene {
	const copies = source.elements.map((element) => ({
		...element,
		points: element.points?.map((point) => ({ ...point })),
		startBinding: element.startBinding ? { ...element.startBinding } : null,
		endBinding: element.endBinding ? { ...element.endBinding } : null,
		groupIds: [...(element.groupIds ?? [])],
	}));
	const ids = new Map<string, string>();
	const groups = new Map<string, string>();
	for (const element of copies) ids.set(element.id, generateElementId(element.type));
	for (const element of copies) {
		for (const groupId of element.groupIds) {
			if (!groups.has(groupId)) groups.set(groupId, generateElementId("group"));
		}
	}
	for (const element of copies) {
		element.id = ids.get(element.id) ?? generateElementId(element.type);
		element.x += 24;
		element.y += 24;
		element.groupIds = element.groupIds.map((id) => groups.get(id) ?? id);
		element.containerId = element.containerId
			? ids.get(element.containerId) ?? null
			: null;
		element.boundTextId = element.boundTextId
			? ids.get(element.boundTextId) ?? null
			: null;
		element.frameId = element.frameId ? ids.get(element.frameId) ?? null : null;
		if (element.startBinding) {
			element.startBinding.elementId =
				ids.get(element.startBinding.elementId) ??
				element.startBinding.elementId;
		}
		if (element.endBinding) {
			element.endBinding.elementId =
				ids.get(element.endBinding.elementId) ?? element.endBinding.elementId;
		}
		element.updated = Date.now();
	}
	const files: Record<string, SceneFileEntry> = {};
	for (const [id, file] of Object.entries(source.files)) {
		files[id] = { ...file };
	}
	return {
		version: 2,
		title: source.title ? `${source.title} — копия` : undefined,
		order,
		elements: copies,
		appState: {
			...source.appState,
			currentStyle: { ...source.appState.currentStyle },
		},
		files,
	};
}

export class ProjectSchemaView {
	private app: App;
	private container: HTMLElement;
	private callbacks: SchemaViewCallbacks;
	private win: Window & typeof globalThis;
	private scan: ScanResult | null = null;
	private projectRoot: StudyNoteItem | null = null;
	private currentNote: StudyNoteItem | null = null;
	private slides: StudyMediaItem[] = [];
	private activeSlideIndex = -1;
	private scenes: ScenesByKey = new Map();
	private manager: SceneStore | null = null;
	private editor: CanvasSceneEditor | null = null;
	private editorSceneKey = "";
	private cameraBySlide = new Map<string, CameraState>();
	private mediaOperations = new Set<Promise<void>>();
	private sceneLoadOperations = new Set<Promise<void>>();
	private slideLoadRevision = 0;
	private destroyed = false;
	private updateRevision = 0;
	private updateQueue: Promise<void> = Promise.resolve();

	private rootEl!: HTMLDivElement;
	private headerEl!: HTMLDivElement;
	private noteTreeDropdown: MaterialTreeDropdown | null = null;
	private slidesEl!: HTMLDivElement;
	private boardMenuEl!: HTMLDivElement;
	private boardMenuPanelEl!: HTMLDivElement;
	private editorHostEl!: HTMLDivElement;
	private emptyStateEl!: HTMLDivElement;
	private urlBarEl!: HTMLDivElement;
	private urlInputEl!: HTMLInputElement;

	constructor(app: App, container: HTMLElement, callbacks: SchemaViewCallbacks) {
		this.app = app;
		this.container = container;
		this.callbacks = callbacks;
		const win = container.ownerDocument.defaultView;
		if (!win) throw new Error("Не удалось определить окно схемы");
		this.win = win;
		this.buildDOM();
	}

	public getActiveSlideKey(): string {
		return this.slides[this.activeSlideIndex]?.key ?? "";
	}

	public getCameraState(): CameraState {
		return this.editor?.getCameraState() ??
			this.cameraBySlide.get(this.getActiveSlideKey()) ?? {
				scale: 1,
				panX: 0,
				panY: 0,
			};
	}

	public notifyResize(): void {
		this.editor?.notifyResize();
	}

	public update(
		scan: ScanResult,
		projectRoot: StudyNoteItem,
		targetNote: StudyNoteItem,
		preferKey?: string,
		initialCamera?: CameraState | null
	): Promise<void> {
		const revision = ++this.updateRevision;
		this.updateQueue = this.updateQueue
			.then(async () => {
				if (revision !== this.updateRevision || this.destroyed) return;
				await this.performUpdate(
					revision,
					scan,
					projectRoot,
					targetNote,
					preferKey,
					initialCamera
				);
			})
			.catch((error: unknown) => {
				if (revision === this.updateRevision && !this.destroyed) {
					this.reportError("Ошибка загрузки схемы", error);
				}
			});
		return this.updateQueue;
	}

	public async destroy(): Promise<void> {
		if (this.destroyed) return;
		this.destroyed = true;
		this.slideLoadRevision++;
		await Promise.all(
			[...this.mediaOperations, ...this.sceneLoadOperations].map((operation) =>
				operation.catch(() => undefined)
			)
		);
		this.editor?.destroy();
		this.editor = null;
		try {
			await this.manager?.flushSave(this.scenes);
		} catch (error: unknown) {
			this.reportError("Не удалось сохранить схему при закрытии", error);
		}
		this.manager?.release();
		this.manager = null;
		this.noteTreeDropdown?.destroy();
		this.noteTreeDropdown = null;
		this.container.replaceChildren();
	}

	private async performUpdate(
		revision: number,
		scan: ScanResult,
		projectRoot: StudyNoteItem,
		targetNote: StudyNoteItem,
		preferKey?: string,
		initialCamera?: CameraState | null
	): Promise<void> {
		const oldNotePath = this.currentNote?.path ?? "";
		const noteChanged = oldNotePath !== targetNote.path;
		const oldActiveKey = this.getActiveSlideKey();

		if (
			noteChanged &&
			(this.mediaOperations.size > 0 || this.sceneLoadOperations.size > 0)
		) {
			await Promise.all(
				[
					...this.mediaOperations,
					...this.sceneLoadOperations,
				].map((operation) =>
					operation.catch(() => undefined)
				)
			);
			if (revision !== this.updateRevision) return;
		}
		if (noteChanged && this.editor) {
			this.editor.destroy();
			this.editor = null;
			this.editorSceneKey = "";
		}
		if (noteChanged && this.manager) {
			const previousManager = this.manager;
			await previousManager.flushSave(this.scenes);
			if (revision !== this.updateRevision) return;
			previousManager.release();
		}

		this.scan = scan;
		this.projectRoot = projectRoot;
		this.currentNote = targetNote;

		if (noteChanged || !this.manager) {
			this.manager = new SceneStore(
				this.app,
				targetNote.file,
				this.callbacks.getMediaFolder(),
				this.win
			);
			this.scenes = await this.manager.loadScenes();
			this.cameraBySlide.clear();
			this.activeSlideIndex = -1;
			if (revision !== this.updateRevision) return;
		} else if (this.manager.getFile().path !== targetNote.file.path) {
			await this.manager.setFile(targetNote.file);
		}

		this.populateNoteSelect();
		this.refreshSlides();
		const targetKey =
			preferKey ||
			(!noteChanged ? oldActiveKey : "") ||
			this.slides[0]?.key ||
			"";
		const targetIndex = this.slides.findIndex((slide) => slide.key === targetKey);
		this.activeSlideIndex =
			targetIndex >= 0 ? targetIndex : this.slides.length > 0 ? 0 : -1;
		this.renderSlides();

		const activeKey = this.getActiveSlideKey();
		if (!activeKey) {
			this.showEmptyState();
			return;
		}

		if (noteChanged || this.editorSceneKey !== activeKey || !this.editor) {
			await this.loadActiveSlide(initialCamera);
		} else if (initialCamera) {
			this.editor.setCameraState(initialCamera, false);
		} else {
			this.editor.notifyResize();
		}
	}

	private buildDOM(): void {
		this.container.replaceChildren();
		this.container.classList.add("my-sc-schema-host", "my-sc-canvas-project");

		this.rootEl = this.container.ownerDocument.createElement("div");
		this.rootEl.className = "my-sc-canvas-project-root";
		this.container.appendChild(this.rootEl);

		this.headerEl = this.container.ownerDocument.createElement("div");
		this.headerEl.className = "my-sc-schema-header my-sc-canvas-project-header";
		this.rootEl.appendChild(this.headerEl);

		const left = this.container.ownerDocument.createElement("div");
		left.className = "my-sc-schema-header-left";
		this.headerEl.appendChild(left);

		this.noteTreeDropdown = new MaterialTreeDropdown(left, {
			onSelect: (notePath) => this.callbacks.onSelectNote(notePath),
		});

		this.slidesEl = this.container.ownerDocument.createElement("div");
		this.slidesEl.className = "my-sc-schema-slides my-sc-canvas-project-slides";
		left.appendChild(this.slidesEl);

		const boardActions = this.container.ownerDocument.createElement("div");
		boardActions.className = "my-sc-canvas-project-board-actions";
		left.appendChild(boardActions);
		const addBoard = this.createButton(
			boardActions,
			"plus",
			"Добавить холст",
			() => void this.createBoard()
		);
		addBoard.classList.add("my-sc-canvas-mgmt-btn");
		const menuButton = this.createButton(
			boardActions,
			"ellipsis",
			"Действия с холстом",
			() => this.boardMenuPanelEl.classList.toggle("is-hidden")
		);
		menuButton.classList.add("my-sc-canvas-mgmt-btn");
		this.boardMenuEl = boardActions;
		this.boardMenuPanelEl = this.container.ownerDocument.createElement("div");
		this.boardMenuPanelEl.className = "my-sc-canvas-board-menu is-hidden";
		boardActions.appendChild(this.boardMenuPanelEl);

		const right = this.container.ownerDocument.createElement("div");
		right.className = "my-sc-schema-header-right my-sc-canvas-project-header-right";
		this.headerEl.appendChild(right);
		this.createButton(right, "image", "Добавить изображение", () =>
			this.openImagePicker(this.getViewportCenterWorld())
		);
		this.createButton(right, "link", "Добавить URL-карточку", () =>
			this.urlBarEl.classList.toggle("is-hidden")
		);

		this.urlBarEl = this.container.ownerDocument.createElement("div");
		this.urlBarEl.className = "my-sc-schema-url-bar my-sc-canvas-url-bar is-hidden";
		this.rootEl.appendChild(this.urlBarEl);
		this.urlInputEl = this.container.ownerDocument.createElement("input");
		this.urlInputEl.className = "my-sc-input";
		this.urlInputEl.type = "url";
		this.urlInputEl.placeholder = "Вставь URL для карточки…";
		this.urlBarEl.appendChild(this.urlInputEl);
		const addUrl = this.createButton(this.urlBarEl, "", "Добавить на холст", () =>
			this.addUrlCard()
		);
		addUrl.textContent = "Добавить на холст";
		addUrl.classList.add("my-sc-chip-btn", "mod-cta");
		this.urlInputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				this.addUrlCard();
			}
		});

		const stage = this.container.ownerDocument.createElement("div");
		stage.className = "my-sc-schema-stage my-sc-canvas-project-stage";
		this.rootEl.appendChild(stage);

		this.editorHostEl = this.container.ownerDocument.createElement("div");
		this.editorHostEl.className = "my-sc-canvas-editor-host";
		stage.appendChild(this.editorHostEl);

		this.emptyStateEl = this.container.ownerDocument.createElement("div");
		this.emptyStateEl.className = "my-sc-schema-empty-state my-sc-canvas-empty";
		const message = this.container.ownerDocument.createElement("div");
		message.className = "my-sc-schema-empty-text";
		message.textContent = "На этой заметке пока нет холстов.";
		this.emptyStateEl.appendChild(message);
		const emptyAdd = this.createButton(
			this.emptyStateEl,
			"plus",
			"Добавить холст",
			() => void this.createBoard()
		);
		emptyAdd.appendChild(
			this.container.ownerDocument.createTextNode(" Добавить холст")
		);
		stage.appendChild(this.emptyStateEl);
	}

	private createButton(
		parent: HTMLElement,
		icon: string,
		title: string,
		action: () => void
	): HTMLButtonElement {
		const button = this.container.ownerDocument.createElement("button");
		button.type = "button";
		button.className = "my-sc-chip-btn my-sc-canvas-project-button";
		button.title = title;
		button.setAttribute("aria-label", title);
		if (icon) setIcon(button, icon);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			action();
		});
		parent.appendChild(button);
		return button;
	}

	private populateNoteSelect(): void {
		if (!this.scan || !this.projectRoot) {
			this.noteTreeDropdown?.setTree(null, [], "");
			return;
		}
		const tree = buildNestedFilteredTree(this.projectRoot, this.scan, null, {
			query: "",
			mode: "all",
			typeFilter: "",
		});
		this.noteTreeDropdown?.setTree(
			this.projectRoot,
			tree,
			this.currentNote?.path ?? ""
		);
	}

	private refreshSlides(): void {
		if (!this.currentNote) {
			this.slides = [];
			return;
		}
		const media = extractMediaAndAnnotationMeta(
			this.app,
			this.currentNote.file
		).mediaItems;
		const next: StudyMediaItem[] = [];
		const seen = new Set<string>();

		for (const item of media) {
			const scene = this.scenes.get(item.key);
			if (scene?.deleted) continue;
			seen.add(item.key);
			next.push({
				...item,
				label: scene?.title || item.customTitle || item.label,
				customTitle: scene?.title || item.customTitle,
			});
		}

		for (const [key, scene] of this.scenes.entries()) {
			if (scene.deleted || seen.has(key)) continue;
			next.push({
				key,
				label: scene.title || `Холст ${next.length + 1}`,
				customTitle: scene.title,
				src: "",
				kind: "board",
			});
		}

		if (next.length === 0 && this.scenes.size === 0) {
			next.push({
				key: VIRTUAL_BOARD_KEY,
				label: "Холст 1",
				src: "",
				kind: "board",
			});
		}

		const originalIndex = new Map(next.map((slide, index) => [slide.key, index]));
		if (next.some((slide) => Number.isFinite(this.scenes.get(slide.key)?.order))) {
			next.sort((a, b) => {
				const aOrder = this.scenes.get(a.key)?.order;
				const bOrder = this.scenes.get(b.key)?.order;
				return (
					(aOrder ?? originalIndex.get(a.key) ?? 0) -
					(bOrder ?? originalIndex.get(b.key) ?? 0)
				);
			});
		}
		this.slides = next;
	}

	private renderSlides(): void {
		this.slidesEl.replaceChildren();
		for (let index = 0; index < this.slides.length; index++) {
			const slide = this.slides[index]!;
			const button = this.container.ownerDocument.createElement("button");
			button.type = "button";
			button.className = "my-sc-canvas-slide";
			button.classList.toggle("is-active", index === this.activeSlideIndex);
			button.textContent = slide.label || `Холст ${index + 1}`;
			button.title = button.textContent;
			button.setAttribute("aria-pressed", String(index === this.activeSlideIndex));
			button.addEventListener("click", () => void this.selectSlide(index));
			this.slidesEl.appendChild(button);
		}
		this.renderBoardMenu();
	}

	private renderBoardMenu(): void {
		if (!this.boardMenuPanelEl) return;
		this.boardMenuPanelEl.replaceChildren();
		const slide = this.slides[this.activeSlideIndex];
		const actions: Array<{ title: string; icon: string; run: () => void }> = [
			{
				title: "Переименовать",
				icon: "pencil",
				run: () => this.promptRenameCanvas(),
			},
			{
				title: "Дублировать",
				icon: "copy",
				run: () => void this.duplicateCanvas(),
			},
			{
				title: "Переместить влево",
				icon: "arrow-left",
				run: () => void this.moveCanvas(-1),
			},
			{
				title: "Переместить вправо",
				icon: "arrow-right",
				run: () => void this.moveCanvas(1),
			},
			{
				title: "Удалить",
				icon: "trash-2",
				run: () => this.promptDeleteCanvas(),
			},
		];
		for (const action of actions) {
			const button = this.container.ownerDocument.createElement("button");
			button.type = "button";
			button.className = "my-sc-canvas-board-menu-item";
			button.disabled = !slide;
			setIcon(button, action.icon);
			const label = this.container.ownerDocument.createElement("span");
			label.textContent = action.title;
			button.appendChild(label);
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.boardMenuPanelEl.classList.add("is-hidden");
				action.run();
			});
			this.boardMenuPanelEl.appendChild(button);
		}
	}

	private async selectSlide(index: number): Promise<void> {
		if (index < 0 || index >= this.slides.length || index === this.activeSlideIndex) {
			this.boardMenuPanelEl.classList.add("is-hidden");
			return;
		}
		this.saveCurrentCamera();
		this.activeSlideIndex = index;
		this.boardMenuPanelEl.classList.add("is-hidden");
		this.renderSlides();
		await this.loadActiveSlide();
	}

	private loadActiveSlide(initialCamera?: CameraState | null): Promise<void> {
		const revision = ++this.slideLoadRevision;
		this.editorHostEl.classList.add("is-loading");
		const operation = this.performLoadActiveSlide(revision, initialCamera);
		let tracked: Promise<void>;
		tracked = operation
			.catch((error: unknown) => {
				if (revision === this.slideLoadRevision && !this.destroyed) {
					this.reportError("Ошибка загрузки холста", error);
				}
			})
			.finally(() => {
				this.sceneLoadOperations.delete(tracked);
				if (revision === this.slideLoadRevision) {
					this.editorHostEl.classList.remove("is-loading");
				}
			});
		this.sceneLoadOperations.add(tracked);
		return tracked;
	}

	private async performLoadActiveSlide(
		revision: number,
		initialCamera?: CameraState | null
	): Promise<void> {
		const slide = this.slides[this.activeSlideIndex];
		const note = this.currentNote;
		const manager = this.manager;
		const scenes = this.scenes;
		if (!slide || !manager || !note) {
			this.showEmptyState();
			return;
		}
		this.emptyStateEl.classList.add("is-hidden");
		this.editorHostEl.classList.remove("is-hidden");

		let scene = scenes.get(slide.key);
		if (!scene || scene.deleted) {
			scene = createEmptyScene(slide.customTitle);
			scene.order = this.activeSlideIndex;
			scenes.set(slide.key, scene);
		}
		if (
			(slide.kind === "vault" || slide.kind === "external") &&
			!scene.elements.some(isCanvasImageElement)
		) {
			await this.addMediaImageToScene(slide, scene, note, manager, scenes);
		}
		if (
			this.destroyed ||
			revision !== this.slideLoadRevision ||
			this.getActiveSlideKey() !== slide.key
		) {
			return;
		}

		const camera =
			initialCamera ??
			this.cameraBySlide.get(slide.key) ??
			null;
		if (!this.editor) {
			this.editor = new CanvasSceneEditor(
				this.editorHostEl,
				scene,
				{
					onSceneChange: (changedScene) =>
						this.handleSceneChange(this.editorSceneKey, changedScene),
					onCameraChange: (nextCamera) =>
						this.handleCameraChange(this.editorSceneKey, nextCamera),
					onPickImage: (point) => this.openImagePicker(point),
					onPasteImage: (file, point) =>
						this.trackMediaOperation(this.addClipboardImage(file, point)),
					onOpenLink: (link, newTab) => this.handleOpenLink(link, newTab),
					onExportPng: (blob) =>
						this.trackMediaOperation(this.saveExportedPngToVault(blob)),
				},
				(element, currentScene) =>
					this.resolveSceneImage(element, currentScene)
			);
			this.editorSceneKey = slide.key;
		} else {
			this.editor.setScene(scene, camera);
			this.editorSceneKey = slide.key;
		}

		if (
			!camera &&
			scene.elements.length > 0 &&
			scene.appState.zoom === 1 &&
			scene.appState.scrollX === 0 &&
			scene.appState.scrollY === 0
		) {
			this.win.requestAnimationFrame(() => this.editor?.fitToContent());
		}
		this.callbacks.onStateChange?.(slide.key, this.editor.getCameraState());
	}

	private async addMediaImageToScene(
		slide: StudyMediaItem,
		scene: Scene,
		note: StudyNoteItem,
		manager: SceneStore,
		scenes: ScenesByKey
	): Promise<void> {
		const id = `file_${hashStringSeed(slide.key).toString(36)}`;
		const entry: SceneFileEntry =
			slide.kind === "vault"
				? {
						id,
						mime: getImageMime(slide.file?.extension ?? ""),
						vaultPath: slide.file?.path ?? slide.key,
						created: Date.now(),
				  }
				: {
						id,
						mime: getImageMime(this.extensionFromUrl(slide.src)),
						dataURL: slide.src,
						created: Date.now(),
				  };
		scene.files[id] = entry;
		try {
			const dimensions = await this.loadImageDimensions(
				this.resolveFileEntryUrl(entry, note)
			);
			const image = this.makeImageElement(scene, entry, dimensions, {
				x: 0,
				y: 0,
			});
			scene.elements.unshift(image);
			scene.elements.forEach((element, index) => {
				element.zIndex = index;
			});
			scenes.set(slide.key, scene);
			manager.scheduleSave(scenes);
		} catch (error: unknown) {
			if (slide.kind === "external" && isExternalImageUrl(slide.src)) {
				const card: SceneElement = {
					id: generateElementId("url"),
					type: "note",
					x: 0,
					y: 0,
					width: 280,
					height: 120,
					angle: 0,
					strokeColor: DEFAULT_ELEMENT_STYLE.strokeColor,
					backgroundColor: DEFAULT_ELEMENT_STYLE.backgroundColor,
					fillStyle: "solid",
					strokeWidth: 1,
					strokeStyle: "solid",
					roughness: 0,
					opacity: 100,
					roundness: 8,
					text: slide.src,
					fontFamily: "normal",
					fontSize: 16,
					textAlign: "left",
					verticalAlign: "middle",
					groupIds: [],
					locked: false,
					isDeleted: false,
					zIndex: 0,
					updated: Date.now(),
					link: slide.src,
				};
				scene.elements.unshift(card);
				scenes.set(slide.key, scene);
				manager.scheduleSave(scenes);
				new Notice("Внешний URL добавлен как карточка-ссылка.");
				return;
			}
			delete scene.files[id];
			throw error;
		}
	}

	private async createBoard(): Promise<void> {
		if (!this.manager) return;
		this.saveCurrentCamera();
		const used = new Set(this.scenes.keys());
		let key = VIRTUAL_BOARD_KEY;
		let suffix = 1;
		while (used.has(key)) {
			suffix++;
			key = `__board_${suffix}__`;
		}
		const scene = createEmptyScene();
		scene.order = this.slides.length;
		this.scenes.set(key, scene);
		this.slides.push({
			key,
			label: `Холст ${this.slides.length + 1}`,
			src: "",
			kind: "board",
		});
		this.activeSlideIndex = this.slides.length - 1;
		this.manager.scheduleSave(this.scenes);
		this.renderSlides();
		await this.loadActiveSlide();
	}

	private promptRenameCanvas(): void {
		const slide = this.slides[this.activeSlideIndex];
		if (!slide || !this.manager) return;
		new RenameCanvasModal(this.app, slide.customTitle || slide.label, (value) => {
			const scene = this.scenes.get(slide.key) ?? createEmptyScene();
			scene.title = value;
			this.scenes.set(slide.key, scene);
			slide.label = value;
			slide.customTitle = value;
			this.manager?.scheduleSave(this.scenes);
			this.renderSlides();
		}).open();
	}

	private promptDeleteCanvas(): void {
		const slide = this.slides[this.activeSlideIndex];
		if (!slide) return;
		new ConfirmDeleteCanvasModal(this.app, slide.label, () => {
			void this.deleteCanvas();
		}).open();
	}

	private async deleteCanvas(): Promise<void> {
		const slide = this.slides[this.activeSlideIndex];
		if (!slide || !this.manager) return;
		this.saveCurrentCamera();
		const scene = this.scenes.get(slide.key);
		if (slide.kind === "vault" || slide.kind === "external") {
			const tombstone = scene ?? createEmptyScene();
			tombstone.deleted = true;
			tombstone.elements = [];
			this.scenes.set(slide.key, tombstone);
		} else {
			this.scenes.delete(slide.key);
		}
		this.cameraBySlide.delete(slide.key);
		this.slides.splice(this.activeSlideIndex, 1);
		this.activeSlideIndex = Math.min(
			this.activeSlideIndex,
			this.slides.length - 1
		);
		this.manager.scheduleSave(this.scenes);
		this.renderSlides();
		if (this.activeSlideIndex >= 0) {
			await this.loadActiveSlide();
		} else {
			this.editor?.setScene(createEmptyScene());
			this.editorSceneKey = "";
			this.showEmptyState();
		}
	}

	private async duplicateCanvas(): Promise<void> {
		const sourceSlide = this.slides[this.activeSlideIndex];
		if (!sourceSlide || !this.manager) return;
		this.saveCurrentCamera();
		const source = this.scenes.get(sourceSlide.key) ?? createEmptyScene();
		const key = this.createUniqueBoardKey();
		const copy = cloneSceneForBoard(source, this.slides.length);
		copy.title ||= `${sourceSlide.label} — копия`;
		this.scenes.set(key, copy);
		this.slides.splice(this.activeSlideIndex + 1, 0, {
			key,
			label: copy.title,
			customTitle: copy.title,
			src: "",
			kind: "board",
		});
		this.activeSlideIndex++;
		this.assignSlideOrder();
		this.manager.scheduleSave(this.scenes);
		this.renderSlides();
		await this.loadActiveSlide();
	}

	private async moveCanvas(direction: -1 | 1): Promise<void> {
		const nextIndex = this.activeSlideIndex + direction;
		if (
			!this.manager ||
			this.activeSlideIndex < 0 ||
			nextIndex < 0 ||
			nextIndex >= this.slides.length
		) {
			return;
		}
		this.saveCurrentCamera();
		[this.slides[this.activeSlideIndex], this.slides[nextIndex]] = [
			this.slides[nextIndex]!,
			this.slides[this.activeSlideIndex]!,
		];
		this.activeSlideIndex = nextIndex;
		this.assignSlideOrder();
		this.manager.scheduleSave(this.scenes);
		this.renderSlides();
		await this.loadActiveSlide();
	}

	private assignSlideOrder(): void {
		const reordered: ScenesByKey = new Map();
		this.slides.forEach((slide, index) => {
			const scene = this.scenes.get(slide.key) ?? createEmptyScene();
			scene.order = index;
			this.scenes.set(slide.key, scene);
			reordered.set(slide.key, scene);
		});
		for (const [key, scene] of this.scenes.entries()) {
			if (!reordered.has(key)) reordered.set(key, scene);
		}
		this.scenes = reordered;
	}

	private createUniqueBoardKey(): string {
		const used = new Set(this.scenes.keys());
		let number = 1;
		let key = VIRTUAL_BOARD_KEY;
		while (used.has(key)) {
			number++;
			key = `__board_${number}__`;
		}
		return key;
	}

	private openImagePicker(point: { x: number; y: number }): void {
		if (!this.currentNote || !this.getActiveSlideKey()) {
			new Notice("Сначала создай холст для изображения.");
			return;
		}
		new VaultImagePickerModal(this.app, (file) => {
			void this.trackMediaOperation(this.addVaultImage(file, point)).catch((error: unknown) => {
				this.reportError("Не удалось добавить изображение", error);
			});
		}).open();
	}

	private async addVaultImage(
		file: TFile,
		point: { x: number; y: number }
	): Promise<void> {
		const context = this.captureImageContext();
		if (!context) throw new Error("Нет активного холста для изображения");
		const entry: SceneFileEntry = {
			id: generateElementId("file"),
			mime: getImageMime(file.extension),
			vaultPath: file.path,
			created: Date.now(),
		};
		await this.addImageEntry(entry, point, context);
	}

private async saveExportedPngToVault(blob: Blob): Promise<void> {
		if (!this.currentNote) {
			throw new Error("Нет активной заметки для сохранения PNG");
		}
		const savedFile = await saveBinaryImageToVault(
			this.app,
			this.currentNote.file,
			await blob.arrayBuffer(),
			"image/png",
			this.callbacks.getMediaFolder()
		);
		new Notice(`PNG сохранён в хранилище: ${savedFile.path}`);
	}

	private async addClipboardImage(
		file: File,
		point: { x: number; y: number }
	): Promise<void> {
		const context = this.captureImageContext();
		if (!context) throw new Error("Нет активного холста для изображения");
		const savedFile = await saveBinaryImageToVault(
			this.app,
			context.note.file,
			await file.arrayBuffer(),
			file.type || file.name.split(".").pop() || "png",
			this.callbacks.getMediaFolder()
		);
		const entry: SceneFileEntry = {
			id: generateElementId("file"),
			mime: getImageMime(savedFile.extension),
			vaultPath: savedFile.path,
			created: Date.now(),
		};
		await this.addImageEntry(entry, point, context);
	}

	private async addImageEntry(
		entry: SceneFileEntry,
		point: { x: number; y: number },
		context: CanvasImageContext
	): Promise<void> {
		const url = this.resolveFileEntryUrl(entry, context.note);
		const dimensions = await this.loadImageDimensions(url);
		const maxSide = 760;
		const ratio = dimensions.width / Math.max(1, dimensions.height);
		let width = dimensions.width;
		let height = dimensions.height;
		if (width > maxSide || height > maxSide) {
			if (width >= height) {
				width = maxSide;
				height = Math.max(24, Math.round(width / ratio));
			} else {
				height = maxSide;
				width = Math.max(24, Math.round(height * ratio));
			}
		}
		const scene = context.scenes.get(context.key) ?? createEmptyScene();
		scene.files[entry.id] = { ...entry };
		if (
			context.editor &&
			context.editor === this.editor &&
			context.note.path === this.currentNote?.path &&
			context.key === this.getActiveSlideKey()
		) {
			context.editor.addImage(entry, width, height, point);
		} else {
			const image = this.makeImageElement(scene, entry, { width, height }, point);
			scene.elements.push(image);
			context.scenes.set(context.key, scene);
			context.manager.scheduleSave(context.scenes);
		}
	}

	private addUrlCard(): void {
		if (!this.editor) return;
		const url = this.urlInputEl.value.trim();
		if (!this.editor.addUrlCard(url, this.editor.getViewportCenterWorld())) return;
		this.urlInputEl.value = "";
		this.urlBarEl.classList.add("is-hidden");
	}

	private resolveSceneImage(element: SceneElement, scene: Scene): string {
		if (!element.fileId) return "";
		const entry = scene.files[element.fileId];
		return entry ? this.resolveFileEntryUrl(entry) : "";
	}

	private resolveFileEntryUrl(
		entry: SceneFileEntry,
		note: StudyNoteItem | null = this.currentNote
	): string {
		if (entry.dataURL) return entry.dataURL;
		if (entry.vaultPath && note) {
			return resolveImageSource(
				this.app,
				entry.vaultPath,
				note.path
			).src;
		}
		return "";
	}

	private loadImageDimensions(
		url: string
	): Promise<{ width: number; height: number }> {
		if (!url) return Promise.reject(new Error("Не удалось определить путь изображения"));
		return new Promise((resolve, reject) => {
			const image = new this.win.Image();
			const timer = this.win.setTimeout(() => {
				image.onload = null;
				image.onerror = null;
				reject(new Error("Истекло время ожидания загрузки изображения"));
			}, 15000);
			image.onload = () => {
				this.win.clearTimeout(timer);
				resolve({
					width: image.naturalWidth || 640,
					height: image.naturalHeight || 420,
				});
			};
			image.onerror = () => {
				this.win.clearTimeout(timer);
				reject(new Error("Не удалось загрузить изображение"));
			};
			image.src = url;
		});
	}

	private makeImageElement(
		scene: Scene,
		entry: SceneFileEntry,
		dimensions: { width: number; height: number },
		point: { x: number; y: number }
	): SceneElement {
		const width = dimensions.width;
		const height = dimensions.height;
		return {
			id: generateElementId("image"),
			type: "image",
			x: point.x,
			y: point.y,
			width,
			height,
			angle: 0,
			strokeColor: DEFAULT_ELEMENT_STYLE.strokeColor,
			backgroundColor: "transparent",
			fillStyle: "none",
			strokeWidth: 1,
			strokeStyle: "solid",
			roughness: 0,
			opacity: 100,
			roundness: 0,
			fontFamily: "normal",
			fontSize: 18,
			textAlign: "center",
			verticalAlign: "middle",
			groupIds: [],
			locked: false,
			isDeleted: false,
			zIndex: scene.elements.length,
			updated: Date.now(),
			fileId: entry.id,
			aspectRatio: width / Math.max(1, height),
		};
	}

	private getViewportCenterWorld(): { x: number; y: number } {
		return this.editor?.getViewportCenterWorld() ?? { x: 0, y: 0 };
	}

	private handleSceneChange(key: string, scene: Scene): void {
		if (this.destroyed || !this.manager || !key) return;
		this.scenes.set(key, scene);
		this.manager.scheduleSave(this.scenes);
	}

	private captureImageContext(): CanvasImageContext | null {
		const key = this.getActiveSlideKey();
		if (!key || !this.currentNote || !this.manager) return null;
		return {
			key,
			note: this.currentNote,
			manager: this.manager,
			scenes: this.scenes,
			editor: this.editor,
		};
	}

	private trackMediaOperation(operation: Promise<void>): Promise<void> {
		let tracked: Promise<void>;
		tracked = operation.finally(() => this.mediaOperations.delete(tracked));
		this.mediaOperations.add(tracked);
		return tracked;
	}

	private handleCameraChange(key: string, camera: CameraState): void {
		if (this.destroyed) return;
		this.cameraBySlide.set(key, camera);
		this.callbacks.onStateChange?.(key, camera);
	}

	private handleOpenLink(link: string, newTab: boolean): void {
		const raw = link.trim();
		if (isExternalImageUrl(raw)) {
			this.win.open(raw, "_blank", "noopener");
			return;
		}
		const clean = cleanWikiTarget(raw);
		if (!clean) return;
		if (!this.currentNote) return;
		const destination = this.app.metadataCache.getFirstLinkpathDest(
			clean,
			this.currentNote.path
		);
		if (!(destination instanceof TFile)) {
			this.app.workspace.openLinkText(clean, this.currentNote.path, newTab);
			return;
		}
		if (!newTab && this.scan?.byPath.has(destination.path)) {
			this.callbacks.onSelectNote(destination.path);
		} else {
			this.callbacks.onOpenNote(destination.path, newTab);
		}
	}

	private saveCurrentCamera(): void {
		const key = this.getActiveSlideKey();
		if (!key || !this.editor) return;
		const camera = this.editor.getCameraState();
		this.cameraBySlide.set(key, camera);
		this.callbacks.onStateChange?.(key, camera);
	}

	private showEmptyState(): void {
		this.editorHostEl.classList.add("is-hidden");
		this.editorHostEl.classList.remove("is-loading");
		this.emptyStateEl.classList.remove("is-hidden");
		this.renderSlides();
	}

	private extensionFromUrl(url: string): string {
		try {
			return new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "png";
		} catch {
			return "png";
		}
	}

	private reportError(label: string, error: unknown): void {
		new Notice(
			`${label}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}
