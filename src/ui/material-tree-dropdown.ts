import type { StudyNoteItem, TreeNode } from "../types";

export interface MaterialTreeDropdownCallbacks {
	onSelect: (notePath: string) => void;
}

interface VisibleTreeRow {
	path: string;
	parentPath: string | null;
	node: TreeNode;
	element: HTMLDivElement;
}

let nextTreeDropdownId = 0;

export class MaterialTreeDropdown {
	private host: HTMLElement;
	private callbacks: MaterialTreeDropdownCallbacks;
	private doc: Document;
	private win: Window & typeof globalThis;
	private rootEl: HTMLDivElement;
	private triggerEl: HTMLButtonElement;
	private triggerLabelEl: HTMLSpanElement;
	private triggerIconEl: HTMLSpanElement;
	private popoverEl: HTMLDivElement;
	private treeEl: HTMLDivElement;
	private projectRoot: StudyNoteItem | null = null;
	private childNodes: TreeNode[] = [];
	private selectedPath = "";
	private focusedPath = "";
	private collapsedPaths = new Set<string>();
	private parentPathByPath = new Map<string, string | null>();
	private rows: VisibleTreeRow[] = [];
	private typeahead = "";
	private typeaheadTimer: number | null = null;
	private destroyed = false;
	private treeId: string;

	private readonly onDocumentPointerDownBound = (event: PointerEvent) =>
		this.handleDocumentPointerDown(event);
	private readonly onFocusOutBound = (event: FocusEvent) =>
		this.handleFocusOut(event);
	private readonly onTriggerKeyDownBound = (event: KeyboardEvent) =>
		this.handleTriggerKeyDown(event);
	private readonly onTreeKeyDownBound = (event: KeyboardEvent) =>
		this.handleTreeKeyDown(event);

	constructor(host: HTMLElement, callbacks: MaterialTreeDropdownCallbacks) {
		this.host = host;
		this.callbacks = callbacks;
		this.doc = host.ownerDocument;
		const win = this.doc.defaultView;
		if (!win) throw new Error("Не удалось определить окно списка материалов");
		this.win = win;
		this.treeId = `msc-tree-${++nextTreeDropdownId}`;

		this.rootEl = this.doc.createElement("div");
		this.rootEl.className = "msc-tree-select";
		host.appendChild(this.rootEl);

		this.triggerEl = this.doc.createElement("button");
		this.triggerEl.type = "button";
		this.triggerEl.className = "msc-tree-trigger";
		this.triggerEl.setAttribute("role", "combobox");
		this.triggerEl.setAttribute("aria-haspopup", "tree");
		this.triggerEl.setAttribute("aria-expanded", "false");
		this.triggerEl.setAttribute("aria-controls", this.treeId);
		this.triggerEl.setAttribute("aria-label", "Выбрать материал проекта");
		this.rootEl.appendChild(this.triggerEl);

		this.triggerLabelEl = this.doc.createElement("span");
		this.triggerLabelEl.className = "msc-tree-trigger-label";
		this.triggerEl.appendChild(this.triggerLabelEl);
		this.triggerIconEl = this.doc.createElement("span");
		this.triggerIconEl.className = "msc-tree-trigger-icon";
		this.triggerIconEl.setAttribute("aria-hidden", "true");
		this.triggerIconEl.textContent = "▾";
		this.triggerEl.appendChild(this.triggerIconEl);

		this.popoverEl = this.doc.createElement("div");
		this.popoverEl.className = "msc-tree-popover is-hidden";
		this.popoverEl.setAttribute("aria-hidden", "true");
		this.rootEl.appendChild(this.popoverEl);

		this.treeEl = this.doc.createElement("div");
		this.treeEl.className = "msc-tree-list";
		this.treeEl.id = this.treeId;
		this.treeEl.setAttribute("role", "tree");
		this.treeEl.setAttribute("aria-label", "Иерархия материалов проекта");
		this.treeEl.tabIndex = -1;
		this.popoverEl.appendChild(this.treeEl);

		this.triggerEl.addEventListener("click", () => this.toggle());
		this.triggerEl.addEventListener("keydown", this.onTriggerKeyDownBound);
		this.treeEl.addEventListener("keydown", this.onTreeKeyDownBound);
		this.rootEl.addEventListener("focusout", this.onFocusOutBound);
		this.doc.addEventListener(
			"pointerdown",
			this.onDocumentPointerDownBound,
			true
		);
		this.updateTriggerLabel();
	}

	public setTree(
		projectRoot: StudyNoteItem | null,
		childNodes: TreeNode[],
		selectedPath: string
	): void {
		this.projectRoot = projectRoot;
		this.childNodes = childNodes;
		this.selectedPath = selectedPath;
		this.indexTree();
		if (!this.parentPathByPath.has(this.focusedPath)) {
			this.focusedPath = selectedPath || projectRoot?.path || "";
		}
		this.updateTriggerLabel();
		if (this.isOpen()) {
			this.revealSelectedPath();
			this.renderTree();
			this.focusRow(this.focusedPath || this.selectedPath);
		}
	}

	public destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.doc.removeEventListener(
			"pointerdown",
			this.onDocumentPointerDownBound,
			true
		);
		this.rootEl.removeEventListener("focusout", this.onFocusOutBound);
		if (this.typeaheadTimer !== null) {
			this.win.clearTimeout(this.typeaheadTimer);
			this.typeaheadTimer = null;
		}
		this.rootEl.remove();
	}

	private isOpen(): boolean {
		return !this.popoverEl.classList.contains("is-hidden");
	}

	private toggle(): void {
		if (this.isOpen()) {
			this.close(false);
		} else {
			this.open();
		}
	}

	private open(): void {
		if (this.destroyed || !this.projectRoot) return;
		this.revealSelectedPath();
		this.renderTree();
		this.popoverEl.classList.remove("is-hidden");
		this.popoverEl.setAttribute("aria-hidden", "false");
		this.triggerEl.setAttribute("aria-expanded", "true");
		this.triggerIconEl.classList.add("is-open");
		this.focusRow(this.selectedPath || this.projectRoot.path);
	}

	private close(returnFocus: boolean): void {
		this.popoverEl.classList.add("is-hidden");
		this.popoverEl.setAttribute("aria-hidden", "true");
		this.triggerEl.setAttribute("aria-expanded", "false");
		this.triggerIconEl.classList.remove("is-open");
		this.triggerEl.removeAttribute("aria-activedescendant");
		if (returnFocus) this.triggerEl.focus({ preventScroll: true });
	}

	private handleDocumentPointerDown(event: PointerEvent): void {
		const target = event.target;
		if (!target || this.rootEl.contains(target as Node)) return;
		if (this.isOpen()) this.close(false);
	}

	private handleFocusOut(event: FocusEvent): void {
		const nextTarget = event.relatedTarget;
		if (nextTarget && this.rootEl.contains(nextTarget as Node)) return;
		this.win.requestAnimationFrame(() => {
			if (this.destroyed || !this.isOpen()) return;
			const activeElement = this.doc.activeElement;
			if (activeElement && this.rootEl.contains(activeElement)) return;
			this.close(false);
		});
	}

	private handleTriggerKeyDown(event: KeyboardEvent): void {
		if (this.isOpen()) {
			if (event.key === "Escape") {
				event.preventDefault();
				this.close(true);
			}
			return;
		}
		if (
			event.key === "ArrowDown" ||
			event.key === "ArrowUp" ||
			event.key === "Enter" ||
			event.key === " "
		) {
			event.preventDefault();
			this.open();
		}
	}

	private handleTreeKeyDown(event: KeyboardEvent): void {
		if (this.rows.length === 0) return;
		const index = this.rows.findIndex((row) => row.path === this.focusedPath);
		const current = this.rows[index] ?? this.rows[0]!;

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				this.focusRow(this.rows[Math.min(index + 1, this.rows.length - 1)]!.path);
				return;
			case "ArrowUp":
				event.preventDefault();
				this.focusRow(this.rows[Math.max(0, index - 1)]!.path);
				return;
			case "Home":
				event.preventDefault();
				this.focusRow(this.rows[0]!.path);
				return;
			case "End":
				event.preventDefault();
				this.focusRow(this.rows[this.rows.length - 1]!.path);
				return;
			case "ArrowRight":
				event.preventDefault();
				this.expandOrEnterChild(current);
				return;
			case "ArrowLeft":
				event.preventDefault();
				this.collapseOrFocusParent(current);
				return;
			case "Enter":
				event.preventDefault();
				this.select(current.path);
				return;
			case " ":
				event.preventDefault();
				if (current.node.hasChildren) this.toggleBranch(current.path);
				else this.select(current.path);
				return;
			case "Escape":
				event.preventDefault();
				this.close(true);
				return;
			default:
				if (
					event.key.length === 1 &&
					!event.ctrlKey &&
					!event.metaKey &&
					!event.altKey
				) {
					this.handleTypeahead(event.key);
				}
		}
	}

	private expandOrEnterChild(row: VisibleTreeRow): void {
		if (!row.node.hasChildren) return;
		if (this.collapsedPaths.has(row.path)) {
			this.toggleBranch(row.path);
			return;
		}
		const firstChild = row.node.children[0];
		if (firstChild) this.focusRow(firstChild.item.path);
	}

	private collapseOrFocusParent(row: VisibleTreeRow): void {
		if (row.node.hasChildren && !this.collapsedPaths.has(row.path)) {
			this.toggleBranch(row.path);
			return;
		}
		if (row.parentPath) this.focusRow(row.parentPath);
	}

	private toggleBranch(path: string): void {
		const scrollTop = this.treeEl.scrollTop;
		if (this.collapsedPaths.has(path)) {
			this.collapsedPaths.delete(path);
		} else {
			this.collapsedPaths.add(path);
		}
		this.focusedPath = path;
		this.renderTree();
		this.treeEl.scrollTop = scrollTop;
		this.focusRow(path);
	}

	private handleTypeahead(character: string): void {
		this.typeahead += character.toLocaleLowerCase();
		if (this.typeaheadTimer !== null) {
			this.win.clearTimeout(this.typeaheadTimer);
		}
		this.typeaheadTimer = this.win.setTimeout(() => {
			this.typeahead = "";
			this.typeaheadTimer = null;
		}, 700);

		const start = Math.max(
			0,
			this.rows.findIndex((row) => row.path === this.focusedPath)
		);
		for (let offset = 1; offset <= this.rows.length; offset++) {
			const index = (start + offset) % this.rows.length;
			const row = this.rows[index]!;
			if (
				row.node.item.name
					.toLocaleLowerCase()
					.startsWith(this.typeahead)
			) {
				this.focusRow(row.path);
				return;
			}
		}
	}

	private select(path: string): void {
		this.selectedPath = path;
		this.updateTriggerLabel();
		this.close(true);
		this.callbacks.onSelect(path);
	}

	private updateTriggerLabel(): void {
		if (!this.projectRoot) {
			this.triggerLabelEl.textContent = "Выбрать материал";
			this.triggerEl.title = "Выбрать материал проекта";
			return;
		}
		const item = this.findItem(this.selectedPath) ?? this.projectRoot;
		this.triggerLabelEl.textContent = item.path === this.projectRoot.path
			? `📁 ${this.formatDisplayName(item.name)}`
			: this.formatDisplayName(item.name);
		this.triggerEl.title = item.name;
	}

	private formatDisplayName(name: string): string {
		return name.includes("$") ? name.replace(/[$_]/g, "") : name;
	}

	private findItem(path: string): StudyNoteItem | null {
		if (!path || !this.projectRoot) return null;
		if (this.projectRoot.path === path) return this.projectRoot;
		const findIn = (nodes: TreeNode[]): StudyNoteItem | null => {
			for (const node of nodes) {
				if (node.item.path === path) return node.item;
				const nested = findIn(node.children);
				if (nested) return nested;
			}
			return null;
		};
		return findIn(this.childNodes);
	}

	private indexTree(): void {
		this.parentPathByPath.clear();
		if (!this.projectRoot) return;
		this.parentPathByPath.set(this.projectRoot.path, null);
		const visit = (nodes: TreeNode[], parentPath: string) => {
			for (const node of nodes) {
				this.parentPathByPath.set(node.item.path, parentPath);
				visit(node.children, node.item.path);
			}
		};
		visit(this.childNodes, this.projectRoot.path);
	}

	private revealSelectedPath(): void {
		let parentPath = this.parentPathByPath.get(this.selectedPath) ?? null;
		while (parentPath) {
			this.collapsedPaths.delete(parentPath);
			parentPath = this.parentPathByPath.get(parentPath) ?? null;
		}
	}

	private makeRootNode(): TreeNode | null {
		if (!this.projectRoot) return null;
		const descendantCount = this.countDescendants(this.childNodes);
		return {
			item: this.projectRoot,
			depth: 0,
			hasChildren: this.childNodes.length > 0,
			isExpanded: !this.collapsedPaths.has(this.projectRoot.path),
			directChildrenCount: this.childNodes.length,
			descendantCount,
			isDirectMatch: false,
			children: this.childNodes,
		};
	}

	private countDescendants(nodes: TreeNode[]): number {
		return nodes.reduce(
			(count, node) => count + 1 + this.countDescendants(node.children),
			0
		);
	}

	private renderTree(): void {
		this.rows = [];
		this.treeEl.replaceChildren();
		const root = this.makeRootNode();
		if (root) this.renderNode(root, this.treeEl, 0, null, null);
		this.treeEl.setAttribute(
			"aria-activedescendant",
			this.rows.find((row) => row.path === this.focusedPath)?.element.id ?? ""
		);
	}

	private renderNode(
		node: TreeNode,
		parent: HTMLElement,
		depth: number,
		parentPath: string | null,
		branchColorIndex: number | null
	): void {
		const colorKey =
			depth === 0 ? "root" : String((branchColorIndex ?? 0) % 6);
		const wrapper = this.doc.createElement("div");
		wrapper.className = "msc-tree-node";
		wrapper.dataset["depth"] = String(depth);
		wrapper.dataset["branchColor"] = colorKey;

		const row = this.doc.createElement("div");
		row.className = "msc-tree-row";
		row.setAttribute("role", "treeitem");
		row.setAttribute("aria-level", String(depth + 1));
		row.setAttribute("aria-selected", String(node.item.path === this.selectedPath));
		row.tabIndex = -1;
		row.id = `${this.treeId}-row-${this.rows.length}`;
		row.dataset["path"] = node.item.path;
		row.dataset["depth"] = String(depth);
		row.dataset["branchColor"] = colorKey;
		row.title = node.item.name;
		row.classList.toggle("is-branch", node.hasChildren);
		row.classList.toggle("is-leaf", !node.hasChildren);
		row.classList.toggle("is-selected", node.item.path === this.selectedPath);
		row.classList.toggle("is-focused", node.item.path === this.focusedPath);
		if (node.hasChildren) {
			row.setAttribute(
				"aria-expanded",
				String(!this.collapsedPaths.has(node.item.path))
			);
		}

		if (node.hasChildren) {
			const expander = this.doc.createElement("button");
			expander.type = "button";
			expander.className = "msc-tree-expander";
			expander.tabIndex = -1;
			const expanded = !this.collapsedPaths.has(node.item.path);
			expander.classList.toggle("is-collapsed", !expanded);
			expander.setAttribute("aria-expanded", String(expanded));
			expander.setAttribute(
				"aria-label",
				`${expanded ? "Свернуть" : "Развернуть"}: ${node.item.name}`
			);
			const glyph = this.doc.createElement("span");
			glyph.className = "msc-tree-expander-glyph";
			glyph.textContent = "▾";
			expander.appendChild(glyph);
			expander.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.toggleBranch(node.item.path);
			});
			row.appendChild(expander);
		} else {
			const dot = this.doc.createElement("span");
			dot.className = "msc-tree-leaf-dot";
			dot.setAttribute("aria-hidden", "true");
			row.appendChild(dot);
		}

		const title = this.doc.createElement("span");
		title.className = "msc-tree-title";
		title.textContent = this.formatDisplayName(
			node.item.path === this.projectRoot?.path
				? `${node.item.name} — основной проект`
				: node.item.name
		);
		title.title = node.item.name;
		row.appendChild(title);

		if (node.hasChildren) {
			const count = this.doc.createElement("span");
			count.className = "msc-tree-count";
			count.textContent = String(node.descendantCount);
			count.setAttribute("aria-label", `Потомков: ${node.descendantCount}`);
			row.appendChild(count);
		}

		row.addEventListener("click", () => this.select(node.item.path));
		wrapper.appendChild(row);
		this.rows.push({ path: node.item.path, parentPath, node, element: row });

		if (node.hasChildren && !this.collapsedPaths.has(node.item.path)) {
			const group = this.doc.createElement("div");
			group.className = "msc-tree-children";
			group.dataset["branchColor"] = colorKey;
			group.setAttribute("role", "group");
			node.children.forEach((child, index) => {
				const childColor =
					depth === 0 ? index % 6 : branchColorIndex ?? 0;
				this.renderNode(
					child,
					group,
					depth + 1,
					node.item.path,
					childColor
				);
			});
			wrapper.appendChild(group);
		}
		parent.appendChild(wrapper);
	}

	private focusRow(path: string): void {
		const row = this.rows.find((candidate) => candidate.path === path);
		if (!row) return;
		this.focusedPath = path;
		for (const candidate of this.rows) {
			const focused = candidate.path === path;
			candidate.element.tabIndex = focused ? 0 : -1;
			candidate.element.classList.toggle("is-focused", focused);
		}
		row.element.focus({ preventScroll: true });
		row.element.scrollIntoView({ block: "nearest" });
		this.treeEl.setAttribute("aria-activedescendant", row.element.id);
	}
}
