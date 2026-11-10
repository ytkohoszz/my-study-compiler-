// C:\Users\user\dev\my-study-compiler\src\scene\store.ts
import { App, Notice, TFile } from "obsidian";
import { KEYS, NodePin } from "../types";
import {
	Scene,
	SceneElement,
	SceneFileEntry,
	cloneSceneElement,
	createEmptyScene,
	generateElementId,
} from "./types";
import { backupLegacyAnnotationsIfNeeded, migrateLegacy } from "./migrate";

export type ScenesByKey = Map<string, Scene>;

interface SharedSceneState {
	sceneMap: ScenesByKey | null;
	loadPromise: Promise<ScenesByKey> | null;
	pendingMap: ScenesByKey | null;
	debounceTimer: number | null;
	timerWindow: (Window & typeof globalThis) | null;
	saveQueue: Promise<void>;
	generation: number;
	references: number;
}

const sharedStateByApp = new WeakMap<App, Map<string, SharedSceneState>>();

function acquireSharedState(app: App, filePath: string): SharedSceneState {
	let states = sharedStateByApp.get(app);
	if (!states) {
		states = new Map<string, SharedSceneState>();
		sharedStateByApp.set(app, states);
	}
	let state = states.get(filePath);
	if (!state) {
		state = {
			sceneMap: null,
			loadPromise: null,
			pendingMap: null,
			debounceTimer: null,
			timerWindow: null,
			saveQueue: Promise.resolve(),
			generation: 0,
			references: 0,
		};
		states.set(filePath, state);
	}
	state.references++;
	return state;
}

function cloneScene(scene: Scene): Scene {
	const filesCopy: Record<string, SceneFileEntry> = {};
	for (const [k, v] of Object.entries(scene.files)) {
		filesCopy[k] = { ...v };
	}
	return {
		version: 2,
		title: scene.title,
		deleted: scene.deleted,
		order: scene.order,
		elements: scene.elements.map((el) => cloneSceneElement(el)),
		appState: {
			...scene.appState,
			currentStyle: { ...scene.appState.currentStyle },
		},
		files: filesCopy,
	};
}

function cloneScenesMap(map: ScenesByKey): ScenesByKey {
	const out: ScenesByKey = new Map();
	for (const [k, s] of map.entries()) {
		out.set(k, cloneScene(s));
	}
	return out;
}

/**
 * Хранилище всех холстов (`Scene` v2) конкретной заметки в YAML-свойстве `схемы_аннотации`.
 * Поддерживает:
 * - дебаунс автосохранения 500 мс;
 * - последовательную атомарную очередь записи (без гонок при быстром рисовании/переключении);
 * - гарантированный сброс несохранённых данных (`flushSave`) при смене заметки или закрытии вида;
 * - прозрачную миграцию `схемы_пины` и v1-массивов в `Scene` v2 с созданием резервной копии.
 */
export class SceneStore {
	private app: App;
	private file: TFile;
	private mediaFolder: string;
	private win: Window & typeof globalThis;
	private shared: SharedSceneState;
	private sharedPath: string;
	private released = false;

	constructor(
		app: App,
		file: TFile,
		mediaFolder: string,
		win: Window & typeof globalThis
	) {
		this.app = app;
		this.file = file;
		this.mediaFolder = mediaFolder;
		this.win = win;
		this.sharedPath = file.path;
		this.shared = acquireSharedState(app, file.path);
	}

	public getFile(): TFile {
		return this.file;
	}

	public async setFile(nextFile: TFile): Promise<void> {
		if (this.file.path !== nextFile.path) {
			await this.flushSave();
			this.releaseSharedState();
			this.file = nextFile;
			this.sharedPath = nextFile.path;
			this.shared = acquireSharedState(this.app, nextFile.path);
			this.released = false;
		}
	}

	public release(): void {
		this.releaseSharedState();
	}

	public scheduleSave(scenesMap: ScenesByKey, delayMs = 500): void {
		this.shared.sceneMap = scenesMap;
		this.shared.pendingMap = cloneScenesMap(scenesMap);
		this.shared.generation++;
		const generation = this.shared.generation;
		if (this.shared.debounceTimer !== null && this.shared.timerWindow) {
			this.shared.timerWindow.clearTimeout(this.shared.debounceTimer);
		}
		this.shared.timerWindow = this.win;
		this.shared.debounceTimer = this.win.setTimeout(() => {
			this.shared.debounceTimer = null;
			this.shared.timerWindow = null;
			if (generation !== this.shared.generation) return;
			const toWrite = this.shared.pendingMap;
			this.shared.pendingMap = null;
			if (toWrite) {
				void this.writeScenesToFrontmatter(toWrite).catch((error: unknown) => {
					this.reportSaveError(error);
				});
			}
		}, delayMs);
	}

	public async flushSave(scenesMap?: ScenesByKey): Promise<void> {
		if (this.shared.debounceTimer !== null && this.shared.timerWindow) {
			this.shared.timerWindow.clearTimeout(this.shared.debounceTimer);
			this.shared.debounceTimer = null;
			this.shared.timerWindow = null;
		}
		this.shared.generation++;
		if (scenesMap) this.shared.sceneMap = scenesMap;
		const mapToWrite = scenesMap
			? cloneScenesMap(scenesMap)
			: this.shared.pendingMap;
		this.shared.pendingMap = null;
		if (mapToWrite) {
			await this.writeScenesToFrontmatter(mapToWrite);
		} else {
			await this.shared.saveQueue;
		}
	}

	public async loadScenes(
		defaultWidth = 1400,
		defaultHeight = 900
	): Promise<ScenesByKey> {
		if (this.shared.sceneMap) return this.shared.sceneMap;
		if (this.shared.loadPromise) return await this.shared.loadPromise;

		const loadPromise = this.loadScenesFromFrontmatter(
			defaultWidth,
			defaultHeight
		);
		this.shared.loadPromise = loadPromise;
		try {
			const scenes = await loadPromise;
			this.shared.sceneMap = scenes;
			return scenes;
		} finally {
			if (this.shared.loadPromise === loadPromise) {
				this.shared.loadPromise = null;
			}
		}
	}

	private async loadScenesFromFrontmatter(
		defaultWidth: number,
		defaultHeight: number
	): Promise<ScenesByKey> {
		const cache = this.app.metadataCache.getFileCache(this.file);
		const fm = cache?.frontmatter ?? {};

		const rawAnnotationsValue = fm[KEYS.annotations];
		const rawLegacyPinsValue = fm[KEYS.legacyPins];
		const rawAnnotations =
			rawAnnotationsValue &&
			typeof rawAnnotationsValue === "object" &&
			!Array.isArray(rawAnnotationsValue)
				? (rawAnnotationsValue as Record<string, unknown>)
				: {};
		const rawLegacyPins =
			rawLegacyPinsValue &&
			typeof rawLegacyPinsValue === "object" &&
			!Array.isArray(rawLegacyPinsValue)
				? (rawLegacyPinsValue as Record<string, unknown>)
				: {};

		const result: ScenesByKey = new Map();
		let anyMigratedFromV1 = false;
		let anyLegacyPinsMigrated = false;

		for (const [canvasKey, rawEntry] of Object.entries(rawAnnotations)) {
			const { scene, wasMigrated } = migrateLegacy(rawEntry);
			if (wasMigrated) {
				anyMigratedFromV1 = true;
			}
			result.set(canvasKey, scene);
		}

		// Миграция самых старых пинов (`схемы_пины`)
		if (Object.keys(rawLegacyPins).length > 0) {
			for (const [imgName, pins] of Object.entries(rawLegacyPins)) {
				if (Array.isArray(pins) && !result.has(imgName)) {
					const scene = createEmptyScene();
					scene.elements = pins.map((p, idx): SceneElement => {
						const oldPin = p as NodePin;
						const id = generateElementId("text");
						return {
							id,
							type: "text",
							x: Math.round((oldPin.x ?? 0) * defaultWidth),
							y: Math.round((oldPin.y ?? 0) * defaultHeight),
							width: 220,
							height: 54,
							angle: 0,
							strokeColor: "#e5a158",
							backgroundColor: "rgba(18, 20, 26, 0.82)",
							fillStyle: "solid",
							strokeWidth: 1,
							strokeStyle: "solid",
							roughness: 0,
							opacity: 100,
							roundness: 6,
							text: String(oldPin.text ?? ""),
							fontFamily: "normal",
							fontSize: 16,
							textAlign: "left",
							verticalAlign: "top",
							groupIds: [],
							locked: false,
							isDeleted: false,
							zIndex: idx,
							updated: Date.now(),
						};
					});
					result.set(imgName, scene);
					anyLegacyPinsMigrated = true;
				}
			}
		}

		if (anyMigratedFromV1 || anyLegacyPinsMigrated) {
			await backupLegacyAnnotationsIfNeeded(
				this.app,
				this.file,
				rawAnnotations,
				rawLegacyPins,
				this.mediaFolder
			);
			await this.writeScenesToFrontmatter(result, anyLegacyPinsMigrated);
		}

		return result;
	}

	private serializeSceneForYaml(scene: Scene): Record<string, unknown> {
		if (scene.deleted) {
			return { version: 2, deleted: true };
		}

		const activeElements = scene.elements
			.filter((el) => !el.isDeleted)
			.sort((a, b) => a.zIndex - b.zIndex)
			.map((el, idx) => {
				const clean: Record<string, unknown> = {
					id: el.id,
					type: el.type,
					x: Math.round(el.x * 100) / 100,
					y: Math.round(el.y * 100) / 100,
					width: Math.max(1, Math.round(el.width * 100) / 100),
					height: Math.max(1, Math.round(el.height * 100) / 100),
					angle: Math.round((el.angle || 0) * 10000) / 10000,
					strokeColor: el.strokeColor,
					backgroundColor: el.backgroundColor,
					fillStyle: el.fillStyle,
					strokeWidth: el.strokeWidth,
					strokeStyle: el.strokeStyle,
					roughness: el.roughness,
					opacity: el.opacity,
					roundness: el.roundness,
					fontFamily: el.fontFamily,
					fontSize: el.fontSize,
					textAlign: el.textAlign,
					verticalAlign: el.verticalAlign,
					groupIds: el.groupIds ?? [],
					locked: Boolean(el.locked),
					isDeleted: false,
					zIndex: idx,
					updated: el.updated || Date.now(),
				};

				if (el.points && el.points.length > 0) {
					clean["points"] = el.points.map((p) => {
						const pt: Record<string, number> = {
							x: Math.round(p.x * 100) / 100,
							y: Math.round(p.y * 100) / 100,
						};
						if (typeof p.pressure === "number") {
							pt["pressure"] = Math.round(p.pressure * 1000) / 1000;
						}
						return pt;
					});
				}
				if (el.startBinding) clean["startBinding"] = el.startBinding;
				if (el.endBinding) clean["endBinding"] = el.endBinding;
				if (el.startArrowhead && el.startArrowhead !== "none") {
					clean["startArrowhead"] = el.startArrowhead;
				}
				if (el.endArrowhead && el.endArrowhead !== "none") {
					clean["endArrowhead"] = el.endArrowhead;
				}
				if (el.curved) clean["curved"] = true;
				if (el.elbowed) clean["elbowed"] = true;
				if (typeof el.text === "string" && el.text.length > 0) {
					clean["text"] = el.text;
				}
				if (el.containerId) clean["containerId"] = el.containerId;
				if (el.boundTextId) clean["boundTextId"] = el.boundTextId;
				if (el.frameId) clean["frameId"] = el.frameId;
				if (el.link) clean["link"] = el.link;
				if (el.fileId) clean["fileId"] = el.fileId;
				if (typeof el.aspectRatio === "number" && el.aspectRatio > 0) {
					clean["aspectRatio"] = Number(el.aspectRatio.toFixed(4));
				}

				return clean;
			});

		// Оставляем в files только те файлы, на которые реально ссылаются элементы
		const usedFileIds = new Set<string>();
		for (const el of scene.elements) {
			if (!el.isDeleted && el.fileId) {
				usedFileIds.add(el.fileId);
			}
		}
		const cleanFiles: Record<string, SceneFileEntry> = {};
		for (const [fId, fEntry] of Object.entries(scene.files)) {
			if (usedFileIds.has(fId)) {
				cleanFiles[fId] = fEntry;
			}
		}

		const serialized: Record<string, unknown> = {
			version: 2,
			order: scene.order,
			elements: activeElements,
			appState: {
				scrollX: Math.round(scene.appState.scrollX),
				scrollY: Math.round(scene.appState.scrollY),
				zoom: Number(scene.appState.zoom.toFixed(3)),
				grid: scene.appState.grid,
				gridSize: scene.appState.gridSize,
				snapToGrid: scene.appState.snapToGrid,
				snapToObjects: scene.appState.snapToObjects,
				theme: scene.appState.theme,
				keepToolActive: scene.appState.keepToolActive,
				activeTool: scene.appState.activeTool,
				currentStyle: { ...scene.appState.currentStyle },
			},
		};
		if (!Number.isFinite(scene.order)) delete serialized["order"];

		if (scene.title && scene.title.trim().length > 0) {
			serialized["title"] = scene.title.trim();
		}
		if (Object.keys(cleanFiles).length > 0) {
			serialized["files"] = cleanFiles;
		}

		return serialized;
	}

	private async writeScenesToFrontmatter(
		scenesMap: ScenesByKey,
		removeLegacyPins = false
	): Promise<void> {
		const targetFile = this.file;
		const payload: Record<string, unknown> = {};

		for (const [canvasKey, scene] of scenesMap.entries()) {
			payload[canvasKey] = this.serializeSceneForYaml(scene);
		}

		const operation = this.shared.saveQueue.then(async () => {
			await this.app.fileManager.processFrontMatter(
				targetFile,
				(fm: Record<string, unknown>) => {
					if (Object.keys(payload).length === 0) {
						delete fm[KEYS.annotations];
					} else {
						fm[KEYS.annotations] = payload;
					}
					if (removeLegacyPins) {
						delete fm[KEYS.legacyPins];
					}
				}
			);
		});
		this.shared.saveQueue = operation.catch(() => undefined);
		await operation;
	}

	private releaseSharedState(): void {
		if (this.released) return;
		this.released = true;
		const state = this.shared;
		const filePath = this.sharedPath;
		state.references = Math.max(0, state.references - 1);
		if (state.references > 0) return;

		void state.saveQueue.then(() => {
			const states = sharedStateByApp.get(this.app);
			if (
				state.references !== 0 ||
				state.debounceTimer !== null ||
				state.pendingMap !== null ||
				state.loadPromise !== null ||
				states?.get(filePath) !== state
			) {
				return;
			}
			states.delete(filePath);
			if (states.size === 0) sharedStateByApp.delete(this.app);
		});
	}

	private reportSaveError(error: unknown): void {
		new Notice(
			"Ошибка сохранения схемы: " +
				(error instanceof Error ? error.message : String(error))
		);
	}
}