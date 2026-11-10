// C:\Users\user\dev\my-study-compiler\src\scene\history.ts
import { SceneElement, cloneSceneElement } from "./types";

export interface ElementDelta {
	id: string;
	before: SceneElement | null;
	after: SceneElement | null;
}

export interface HistoryBatch {
	timestamp: number;
	deltas: ElementDelta[];
	selectionBefore: string[];
	selectionAfter: string[];
}

const MAX_HISTORY_DEPTH = 200;

function elementsAreEqual(a: SceneElement | null, b: SceneElement | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Стек истории на основе дельт элементов (до 200 шагов).
 * Хранит только изменённые/добавленные/удалённые элементы вместо полных копий сцены.
 */
export class SceneHistory {
	private undoStack: HistoryBatch[] = [];
	private redoStack: HistoryBatch[] = [];
	private pendingSnapshot: Map<string, SceneElement> | null = null;
	private pendingSelectionBefore: string[] = [];

	public clear(): void {
		this.undoStack = [];
		this.redoStack = [];
		this.pendingSnapshot = null;
		this.pendingSelectionBefore = [];
	}

	public canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	public canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/**
	 * Фиксирует состояние элементов перед началом транзакции (drag, resize, draw, property change).
	 */
	public beginTransaction(
		elements: readonly SceneElement[],
		selectedIds: ReadonlySet<string>
	): void {
		const snap = new Map<string, SceneElement>();
		for (const el of elements) {
			snap.set(el.id, cloneSceneElement(el));
		}
		this.pendingSnapshot = snap;
		this.pendingSelectionBefore = Array.from(selectedIds);
	}

	public hasPendingTransaction(): boolean {
		return this.pendingSnapshot !== null;
	}

	public cancelTransaction(): void {
		this.pendingSnapshot = null;
		this.pendingSelectionBefore = [];
	}

	/**
	 * Вычисляет дельту между `beginTransaction` и текущим массивом `elements`.
	 * Возвращает `true`, если хотя бы один элемент изменился.
	 */
	public commitTransaction(
		elements: readonly SceneElement[],
		selectedIds: ReadonlySet<string>
	): boolean {
		if (!this.pendingSnapshot) return false;

		const beforeMap = this.pendingSnapshot;
		this.pendingSnapshot = null;

		const afterMap = new Map<string, SceneElement>();
		for (const el of elements) {
			afterMap.set(el.id, el);
		}

		const allIds = new Set<string>([
			...beforeMap.keys(),
			...afterMap.keys(),
		]);

		const deltas: ElementDelta[] = [];
		for (const id of allIds) {
			const before = beforeMap.get(id) ?? null;
			const after = afterMap.get(id) ?? null;
			if (!elementsAreEqual(before, after)) {
				deltas.push({
					id,
					before: before ? cloneSceneElement(before) : null,
					after: after ? cloneSceneElement(after) : null,
				});
			}
		}

		if (deltas.length === 0) {
			return false;
		}

		this.pushBatch({
			timestamp: Date.now(),
			deltas,
			selectionBefore: this.pendingSelectionBefore,
			selectionAfter: Array.from(selectedIds),
		});
		return true;
	}

	/**
	 * Записывает готовую дельту напрямую.
	 */
	public recordDiff(
		beforeElements: readonly SceneElement[],
		afterElements: readonly SceneElement[],
		selectionBefore: ReadonlySet<string>,
		selectionAfter: ReadonlySet<string>
	): boolean {
		this.beginTransaction(beforeElements, selectionBefore);
		return this.commitTransaction(afterElements, selectionAfter);
	}

	private pushBatch(batch: HistoryBatch): void {
		this.undoStack.push(batch);
		if (this.undoStack.length > MAX_HISTORY_DEPTH) {
			this.undoStack.shift();
		}
		this.redoStack = [];
	}

	public undo(currentElements: readonly SceneElement[]): {
		elements: SceneElement[];
		selection: Set<string>;
	} | null {
		const batch = this.undoStack.pop();
		if (!batch) return null;

		this.redoStack.push(batch);
		const map = new Map<string, SceneElement>();
		for (const el of currentElements) {
			map.set(el.id, cloneSceneElement(el));
		}

		for (const d of batch.deltas) {
			if (d.before === null) {
				map.delete(d.id);
			} else {
				map.set(d.id, cloneSceneElement(d.before));
			}
		}

		const restored = Array.from(map.values()).sort((a, b) => a.zIndex - b.zIndex);
		return {
			elements: restored,
			selection: new Set(batch.selectionBefore),
		};
	}

	public redo(currentElements: readonly SceneElement[]): {
		elements: SceneElement[];
		selection: Set<string>;
	} | null {
		const batch = this.redoStack.pop();
		if (!batch) return null;

		this.undoStack.push(batch);
		const map = new Map<string, SceneElement>();
		for (const el of currentElements) {
			map.set(el.id, cloneSceneElement(el));
		}

		for (const d of batch.deltas) {
			if (d.after === null) {
				map.delete(d.id);
			} else {
				map.set(d.id, cloneSceneElement(d.after));
			}
		}

		const restored = Array.from(map.values()).sort((a, b) => a.zIndex - b.zIndex);
		return {
			elements: restored,
			selection: new Set(batch.selectionAfter),
		};
	}
}