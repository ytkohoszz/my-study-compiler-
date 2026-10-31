import { App, FuzzySuggestModal, Modal, Notice, normalizePath } from "obsidian";
import type MyStudyCompilerPlugin from "./main";
import {
  KEYS,
  MATERIAL_TYPES,
  NEW_NOTE_TYPES,
  QuickFilterMode,
  STATUS_ACTIVE,
  STATUS_DONE,
  StudyNoteItem,
  TreeNode,
} from "./types";
import {
  ScanResult,
  buildBreadcrumbChain,
  buildFilteredTree,
  byName,
  collectDescendants,
  emptyScan,
  ensureFolder,
  findRootPath,
  formatDeadlineBadge,
  getDeadlineTone,
  getWorkMeta,
  progressOf,
  scanStudyVault,
} from "./scanner";

export interface OpenOptions {
  rootPath?: string;
  addUnder?: string;
}

const RENDER_CHUNK_SIZE = 120;

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

export class StudyCompilerModal extends Modal {
  private plugin: MyStudyCompilerPlugin;
  private options: OpenOptions;
  private scan: ScanResult = emptyScan();
  private selectedPath: string;
  private focusBranchPath = "";
  private expanded: Set<string>;
  private cleanups: Array<() => void> = [];
  private refreshTimer: number | null = null;

  private searchQuery = "";
  private filterMode: QuickFilterMode = "all";
  private typeFilter = "";
  private activeRowIndex = -1;
  private renderLimit = RENDER_CHUNK_SIZE;
  private currentVisibleNodes: TreeNode[] = [];

  private barEl!: HTMLElement;
  private searchWrapEl!: HTMLElement;
  private crumbsEl!: HTMLElement;
  private formEl!: HTMLElement;
  private treeEl!: HTMLElement;
  private searchInputEl: HTMLInputElement | null = null;

  private form = {
    open: false,
    title: "",
    type: "Подпроект",
    parentPath: "",
    deadline: "",
  };

  constructor(app: App, plugin: MyStudyCompilerPlugin, options: OpenOptions = {}) {
    super(app);
    this.plugin = plugin;
    this.options = options;
    this.selectedPath = options.rootPath || plugin.settings.lastWorkPath;
    this.expanded = new Set(plugin.settings.expandedPaths);
    this.noRestore();
  }

  private noRestore() {
    (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection = false;
  }

  safeClose() {
    try {
      this.noRestore();
      this.close();
    } catch {
      // игнорируем
    }
  }

  onOpen(): void {
    this.noRestore();
    this.modalEl.addClass("my-sc-modal-container");
    this.contentEl.addClass("my-sc-modal");

    const head = this.contentEl.createDiv("my-sc-head-bar");
    head.createDiv({ cls: "my-sc-head-title", text: "🎓 Проекты и рабочее дерево" });
    const closeBtn = head.createEl("button", {
      cls: "my-sc-close-btn",
      text: "✕",
      attr: { type: "button", title: "Закрыть (Esc)", "aria-label": "Закрыть" },
    });
    closeBtn.onclick = () => this.safeClose();

    this.barEl = this.contentEl.createDiv("my-sc-project-bar");
    this.searchWrapEl = this.contentEl.createDiv("my-sc-search-panel");
    this.crumbsEl = this.contentEl.createDiv("my-sc-crumbs-bar");
    this.formEl = this.contentEl.createDiv("my-sc-form-wrap");
    this.treeEl = this.contentEl.createDiv("my-sc-body");

    const onKeyDown = (e: KeyboardEvent) => this.handleKeyboardNav(e);
    this.modalEl.addEventListener("keydown", onKeyDown);
    this.cleanups.push(() => this.modalEl.removeEventListener("keydown", onKeyDown));

    const onChange = () => this.scheduleRefresh();
    const r1 = this.app.metadataCache.on("changed", onChange);
    const r2 = this.app.vault.on("delete", onChange);
    const r3 = this.app.vault.on("rename", onChange);
    this.cleanups.push(
      () => this.app.metadataCache.offref(r1),
      () => this.app.vault.offref(r2),
      () => this.app.vault.offref(r3)
    );

    this.scan = scanStudyVault(this.app, this.plugin.settings);
    const addUnder = this.options.addUnder;
    if (addUnder && this.scan.byPath.has(addUnder)) {
      this.selectedPath = findRootPath(this.scan, addUnder);
    }
    const root = this.getRoot();
    if (root) {
      const savedFocus = this.plugin.settings.focusedBranchByWork[root.path];
      if (savedFocus && this.scan.byPath.has(savedFocus)) {
        this.focusBranchPath = savedFocus;
      }
    }

    this.renderBar();
    this.renderSearchPanel();
    this.renderBreadcrumbs();
    this.renderTree();

    if (addUnder && this.scan.byPath.has(addUnder)) {
      this.openForm(addUnder);
    } else {
      window.setTimeout(() => this.searchInputEl?.focus(), 40);
    }
  }

  onClose(): void {
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.contentEl.empty();
  }

  private scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.scan = scanStudyVault(this.app, this.plugin.settings);
      this.renderBar();
      this.renderBreadcrumbs();
      this.renderTree();
    }, 220);
  }

  private visibleRoots(): StudyNoteItem[] {
    return this.scan.roots.filter(
      (r) => this.plugin.settings.showCompletedWorks || !r.isDone
    );
  }

  private getRoot(): StudyNoteItem | null {
    const direct = this.scan.roots.find((r) => r.path === this.selectedPath);
    if (direct) return direct;
    const first = this.visibleRoots()[0] ?? null;
    if (first) this.selectedPath = first.path;
    return first;
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

  private setFocusBranch(projectRoot: StudyNoteItem, branchPath: string) {
    this.focusBranchPath = branchPath === projectRoot.path ? "" : branchPath;
    if (this.focusBranchPath) {
      this.plugin.settings.focusedBranchByWork[projectRoot.path] = this.focusBranchPath;
    } else {
      delete this.plugin.settings.focusedBranchByWork[projectRoot.path];
    }
    this.plugin.requestSaveSettings();
    this.activeRowIndex = -1;
    this.renderLimit = RENDER_CHUNK_SIZE;
    this.renderBar();
    this.renderBreadcrumbs();
    this.renderTree();
  }

  private saveExpanded() {
    this.plugin.settings.expandedPaths = [...this.expanded];
    this.plugin.requestSaveSettings();
  }

  private handleKeyboardNav(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      this.searchInputEl?.focus();
      this.searchInputEl?.select();
      return;
    }

    const activeEl = document.activeElement;
    const inFormInput =
      activeEl instanceof HTMLInputElement && activeEl !== this.searchInputEl;
    if (inFormInput || activeEl instanceof HTMLSelectElement) return;

    const len = this.currentVisibleNodes.length;
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
      const picked = this.currentVisibleNodes[this.activeRowIndex];
      if (picked) {
        e.preventDefault();
        this.openNote(picked.item.path);
      }
    } else if (
      (e.key === "ArrowRight" || e.key === "ArrowLeft") &&
      activeEl !== this.searchInputEl &&
      this.activeRowIndex >= 0
    ) {
      const picked = this.currentVisibleNodes[this.activeRowIndex];
      if (!picked || !picked.hasChildren) return;
      e.preventDefault();
      if (e.key === "ArrowRight") this.expanded.add(picked.item.path);
      else this.expanded.delete(picked.item.path);
      this.saveExpanded();
      this.renderTree();
    }
  }

  private highlightActiveRow() {
    const rows = Array.from(this.treeEl.querySelectorAll<HTMLElement>(".my-sc-tree-row"));
    rows.forEach((r, idx) => {
      const isSelected = idx === this.activeRowIndex;
      r.toggleClass("is-kb-active", isSelected);
      if (isSelected) r.scrollIntoView({ block: "nearest" });
    });
  }

  private renderBar() {
    this.barEl.empty();
    const root = this.getRoot();
    if (!root) {
      this.formEl.empty();
      this.barEl.createDiv({
        cls: "my-sc-empty",
        text: `Не найдено проектов с направлением «${this.plugin.settings.studyAreaName}» и без родителя.`,
      });
      return;
    }

    const branchRoot = this.getActiveBranchRoot(root);
    const row1 = this.barEl.createDiv("my-sc-project-select-wrap");
    const sel = row1.createEl("select", { cls: "dropdown my-sc-work-select" });
    let list = this.visibleRoots();
    if (!list.some((r) => r.path === root.path)) list = [root, ...list];
    for (const r of list) {
      const meta = getWorkMeta(r.noteType, r.icon);
      const o = sel.createEl("option", {
        text: `${meta.icon} ${r.name}${r.isDone ? " [завершён]" : ""}`,
        value: r.path,
      });
      if (r.path === root.path) o.selected = true;
    }
    sel.onchange = () => {
      this.selectedPath = sel.value;
      this.plugin.settings.lastWorkPath = sel.value;
      this.focusBranchPath =
        this.plugin.settings.focusedBranchByWork[sel.value] || "";
      this.plugin.requestSaveSettings();
      this.form.open = false;
      this.formEl.empty();
      this.activeRowIndex = -1;
      this.renderBar();
      this.renderBreadcrumbs();
      this.renderTree();
    };

    const doneBtn = row1.createEl("button", {
      cls: "my-sc-chip-btn" + (this.plugin.settings.showCompletedWorks ? " is-active" : ""),
      text: this.plugin.settings.showCompletedWorks ? "✓ Все проекты" : "В работе",
      attr: { type: "button", title: "Показывать завершённые проекты" },
    });
    doneBtn.onclick = () => {
      this.plugin.settings.showCompletedWorks = !this.plugin.settings.showCompletedWorks;
      this.plugin.requestSaveSettings();
      this.renderBar();
      this.renderTree();
    };

    const openBtn = row1.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "📄 Открыть",
      attr: { type: "button", title: "Открыть заметку текущей ветки/проекта" },
    });
    openBtn.onclick = () => this.openNote(branchRoot.path);

    const descendants = collectDescendants(branchRoot.path, this.scan);
    const stats = progressOf(descendants, this.scan);
    const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
    const progWrap = this.barEl.createDiv("my-sc-progress-wrap");
    const progText = progWrap.createDiv("my-sc-progress-text");
    const scopePrefix = branchRoot.path !== root.path ? `Ветка «${branchRoot.name}»: ` : "";
    progText.createSpan({
      text:
        stats.total > 0
          ? `${scopePrefix}выполнено ${stats.done} из ${stats.total} · ${pct}% (всего заметок: ${descendants.size})`
          : `${scopePrefix}задач пока нет (материалов: ${descendants.size})`,
    });
    this.renderDeadline(progText, branchRoot);
    const bar = progWrap.createDiv("my-sc-progress");
    bar.createDiv("my-sc-progress-fill").style.width = `${pct}%`;

    const tools = this.barEl.createDiv("my-sc-tools");
    const addBtn = tools.createEl("button", {
      cls: "my-sc-chip-btn" + (this.form.open ? " is-active" : ""),
      text: this.form.open ? "✕ Закрыть форму" : "＋ Добавить узел",
      attr: { type: "button" },
    });
    addBtn.onclick = () => {
      if (this.form.open) {
        this.form.open = false;
        this.formEl.empty();
        this.renderBar();
      } else {
        this.openForm(branchRoot.path);
      }
    };

    const expandBtn = tools.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "⤢ Развернуть",
      attr: { type: "button" },
    });
    expandBtn.onclick = () => {
      for (const p of collectDescendants(branchRoot.path, this.scan)) {
        if ((this.scan.childrenOf.get(p)?.length ?? 0) > 0) this.expanded.add(p);
      }
      this.saveExpanded();
      this.renderTree();
    };

    const collapseBtn = tools.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "⤡ Свернуть",
      attr: { type: "button" },
    });
    collapseBtn.onclick = () => {
      for (const p of collectDescendants(branchRoot.path, this.scan)) {
        this.expanded.delete(p);
      }
      this.saveExpanded();
      this.renderTree();
    };
  }

  private renderSearchPanel() {
    this.searchWrapEl.empty();
    const row = this.searchWrapEl.createDiv("my-sc-search-row");

    const inp = row.createEl("input", {
      cls: "my-sc-search-input",
      attr: {
        type: "search",
        placeholder: "🔍 Поиск по дереву (название, тип, #тег)… ↑/↓ и Enter",
      },
    });
    inp.value = this.searchQuery;
    this.searchInputEl = inp;
    inp.oninput = () => {
      this.searchQuery = inp.value;
      this.activeRowIndex = 0;
      this.renderLimit = RENDER_CHUNK_SIZE;
      this.renderTree();
    };

    const typeSel = row.createEl("select", {
      cls: "dropdown my-sc-type-filter",
      attr: { title: "Фильтр по типу заметки" },
    });
    typeSel.createEl("option", { text: "Все типы", value: "" });
    for (const t of NEW_NOTE_TYPES) {
      const o = typeSel.createEl("option", { text: t, value: t });
      if (t === this.typeFilter) o.selected = true;
    }
    typeSel.onchange = () => {
      this.typeFilter = typeSel.value;
      this.activeRowIndex = -1;
      this.renderLimit = RENDER_CHUNK_SIZE;
      this.renderTree();
    };

    const chipsRow = this.searchWrapEl.createDiv("my-sc-filter-chips");
    const modes: Array<{ id: QuickFilterMode; label: string }> = [
      { id: "all", label: "Все" },
      { id: "active", label: "В работе" },
      { id: "burning", label: "🔥 Горит (≤3 дн.)" },
      { id: "overdue", label: "⚠️ Просрочено" },
      { id: "materials", label: "📚 Материалы" },
      { id: "done", label: "✓ Готово" },
      {
        id: "orphans",
        label: `🧭 Без родителя (${this.scan.orphans.length})`,
      },
    ];

    for (const m of modes) {
      const chip = chipsRow.createEl("button", {
        cls: "my-sc-filter-chip" + (this.filterMode === m.id ? " is-active" : ""),
        text: m.label,
        attr: { type: "button" },
      });
      chip.onclick = () => {
        this.filterMode = this.filterMode === m.id && m.id !== "all" ? "all" : m.id;
        this.activeRowIndex = -1;
        this.renderLimit = RENDER_CHUNK_SIZE;
        this.renderSearchPanel();
        this.renderTree();
      };
    }
  }

  private renderBreadcrumbs() {
    this.crumbsEl.empty();
    const root = this.getRoot();
    if (!root) return;
    const branchRoot = this.getActiveBranchRoot(root);
    if (branchRoot.path === root.path) {
      this.crumbsEl.addClass("is-hidden");
      return;
    }
    this.crumbsEl.removeClass("is-hidden");

    const chain = buildBreadcrumbChain(this.scan, root.path, branchRoot.path);
    this.crumbsEl.createSpan({ cls: "my-sc-crumbs-label", text: "Фокус ветки:" });

    chain.forEach((node, idx) => {
      if (idx > 0) {
        this.crumbsEl.createSpan({ cls: "my-sc-crumb-sep", text: "›" });
      }
      const isLast = idx === chain.length - 1;
      const btn = this.crumbsEl.createEl("button", {
        cls: "my-sc-crumb-btn" + (isLast ? " is-current" : ""),
        text: idx === 0 ? `🏠 ${node.name}` : node.name,
        attr: { type: "button" },
      });
      btn.onclick = () => this.setFocusBranch(root, node.path);
    });

    const resetBtn = this.crumbsEl.createEl("button", {
      cls: "my-sc-crumb-reset",
      text: "✕ Весь проект",
      attr: { type: "button", title: "Вернуться ко всему дереву проекта" },
    });
    resetBtn.onclick = () => this.setFocusBranch(root, root.path);
  }

  private openForm(parentPath: string) {
    const root = this.getRoot();
    if (!root) return;
    this.form.open = true;
    this.form.parentPath = this.scan.byPath.has(parentPath) ? parentPath : root.path;
    this.renderBar();
    this.renderForm();
  }

  private renderForm() {
    this.formEl.empty();
    if (!this.form.open) return;
    const root = this.getRoot();
    if (!root) return;

    const box = this.formEl.createDiv("my-sc-add-box");

    const typeSel = box.createEl("select", { cls: "dropdown" });
    for (const t of NEW_NOTE_TYPES) {
      const o = typeSel.createEl("option", { text: t, value: t });
      if (t === this.form.type) o.selected = true;
    }
    typeSel.onchange = () => {
      this.form.type = typeSel.value;
    };

    const titleInp = box.createEl("input", {
      cls: "my-sc-input",
      attr: { type: "text", placeholder: "Название узла или материала…" },
    });
    titleInp.value = this.form.title;
    titleInp.oninput = () => {
      this.form.title = titleInp.value;
    };

    const parentSel = box.createEl("select", { cls: "dropdown my-sc-parent-select" });
    parentSel.createEl("option", { text: `↳ ${root.name}`, value: root.path });
    const allNodes = buildFilteredTree(root, this.scan, null, {
      query: "",
      mode: "all",
      typeFilter: "",
    });
    for (const n of allNodes) {
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

    const dateInp = box.createEl("input", {
      cls: "my-sc-date",
      attr: { type: "date", title: "Дедлайн (необязательно)" },
    });
    dateInp.value = this.form.deadline;
    dateInp.onchange = () => {
      this.form.deadline = dateInp.value;
    };

    const createBtn = box.createEl("button", {
      cls: "mod-cta my-sc-action-btn",
      text: "Создать",
      attr: { type: "button" },
    });

    const submit = async () => {
      createBtn.disabled = true;
      const ok = await this.createNote(root);
      if (ok) {
        this.form.title = "";
        this.form.deadline = "";
        this.renderForm();
      } else {
        createBtn.disabled = false;
      }
    };
    createBtn.onclick = () => void submit();
    titleInp.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) void submit();
    });
    titleInp.focus();
  }

  private async createNote(root: StudyNoteItem): Promise<boolean> {
    const cleanTitle = this.form.title.trim().replace(/[\\/:*?"<>|]/g, "");
    if (!cleanTitle) {
      new Notice("Введи название.");
      return false;
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
        `${KEYS.type}: ${JSON.stringify(this.form.type)}`,
        `${KEYS.parent}: ${JSON.stringify(`[[${link}]]`)}`,
      ];
      if (root.discipline) lines.push(`${KEYS.discipline}: ${JSON.stringify(root.discipline)}`);
      if (/^\d{4}-\d{2}-\d{2}$/.test(this.form.deadline)) {
        lines.push(`${KEYS.deadline}: ${JSON.stringify(this.form.deadline)}`);
      }
      lines.push("---", "", `# ${cleanTitle}`, "", "");
      await this.app.vault.create(targetPath, lines.join("\n"));

      this.expanded.add(parent.path);
      this.saveExpanded();
      new Notice(`Создано: «${cleanTitle}»`);
      return true;
    } catch (err: unknown) {
      new Notice("Ошибка создания: " + (err instanceof Error ? err.message : String(err)));
      return false;
    }
  }

  private renderDeadline(parent: HTMLElement, item: StudyNoteItem) {
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
      text: `⏳ ${formatDeadlineBadge(item)}`,
      attr: {
        title:
          tone === "overdue"
            ? "Дедлайн просрочен"
            : tone === "soon"
              ? "Дедлайн скоро (≤ 3 дней)"
              : `Дедлайн: ${item.deadline}`,
      },
    });
  }

  private renderHighlightedTitle(container: HTMLElement, text: string, query: string) {
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

  private openNote(path: string) {
    this.safeClose();
    void this.app.workspace.openLinkText(path, "", false);
  }

  private renderTree() {
    const scrollTop = this.treeEl.scrollTop;
    this.treeEl.empty();
    const root = this.getRoot();
    if (!root) return;

    const branchRoot = this.getActiveBranchRoot(root);
    const nodes = buildFilteredTree(branchRoot, this.scan, this.expanded, {
      query: this.searchQuery,
      mode: this.filterMode,
      typeFilter: this.typeFilter,
    });
    this.currentVisibleNodes = nodes;

    if (nodes.length === 0) {
      const hasFilters =
        this.searchQuery.trim().length > 0 ||
        this.filterMode !== "all" ||
        this.typeFilter.length > 0;
      this.treeEl.createDiv({
        cls: "my-sc-empty",
        text: hasFilters
          ? "По текущему запросу или фильтру ничего не найдено."
          : "В этой ветке пока нет дочерних узлов. Нажми «＋ Добавить узел».",
      });
      return;
    }

    const list = this.treeEl.createDiv("my-sc-tree-list");
    const sliced = nodes.slice(0, this.renderLimit);

    sliced.forEach((node, idx) => {
      const item = node.item;
      const row = list.createDiv(
        "my-sc-tree-row" +
          (item.isDone ? " is-done" : "") +
          (node.isDirectMatch ? " is-match" : "") +
          (idx === this.activeRowIndex ? " is-kb-active" : "")
      );
      row.style.paddingLeft = `${8 + node.depth * 18}px`;

      const left = row.createDiv("my-sc-tree-left");

      if (node.hasChildren) {
        const isOpen =
          this.searchQuery.trim().length > 0 ||
          this.filterMode !== "all" ||
          this.typeFilter.length > 0 ||
          this.expanded.has(item.path);
        const arrow = left.createEl("button", {
          cls: "my-sc-arrow",
          text: isOpen ? "▾" : "▸",
          attr: { type: "button", "aria-label": isOpen ? "Свернуть" : "Развернуть" },
        });
        arrow.onclick = () => {
          if (this.expanded.has(item.path)) this.expanded.delete(item.path);
          else this.expanded.add(item.path);
          this.saveExpanded();
          this.renderTree();
        };
      } else {
        left.createSpan("my-sc-arrow-spacer");
      }

      const chk = left.createEl("input", {
        attr: { type: "checkbox", title: "Отметить выполненным" },
      });
      chk.checked = item.isDone;
      chk.onchange = () => void this.setDone(item, chk.checked);

      const title = left.createSpan({
        cls: "my-sc-node-title",
        attr: { title: `${item.name} (${item.path})` },
      });
      this.renderHighlightedTitle(title, item.name, this.searchQuery);
      title.onclick = () => this.openNote(item.path);

      const meta = getWorkMeta(item.noteType, item.icon);
      const badge = left.createSpan({
        cls: "my-sc-type-badge",
        text: `${meta.icon} ${item.noteType || "без типа"}`,
      });
      badge.style.setProperty("--badge-color", meta.color);

      if (item.parentPaths.length > 1) {
        left.createSpan({
          cls: "my-sc-multi-parent",
          text: `×${item.parentPaths.length}`,
          attr: { title: `Привязана к ${item.parentPaths.length} родителям` },
        });
      }

      const right = row.createDiv("my-sc-tree-right");
      this.renderDeadline(right, item);
      if (node.total > 0) {
        right.createSpan({
          cls: "my-sc-branch-count",
          text: `${node.done}/${node.total}`,
          attr: { title: "Выполнено задач в ветке" },
        });
      }

      if (node.hasChildren || !MATERIAL_TYPES.includes(item.noteType)) {
        const focusBtn = right.createEl("button", {
          cls: "my-sc-move-btn",
          text: "🎯",
          attr: { type: "button", title: "Сфокусироваться только на этой ветке" },
        });
        focusBtn.onclick = () => this.setFocusBranch(root, item.path);
      }

      const addBtn = right.createEl("button", {
        cls: "my-sc-move-btn",
        text: "＋",
        attr: { type: "button", title: "Добавить дочерний узел сюда" },
      });
      addBtn.onclick = () => this.openForm(item.path);

      const moveBtn = right.createEl("button", {
        cls: "my-sc-move-btn",
        text: "⇄",
        attr: { type: "button", title: "Сменить родителя" },
      });
      moveBtn.onclick = () => this.openMovePicker(item);
    });

    if (nodes.length > this.renderLimit) {
      const moreBtn = list.createEl("button", {
        cls: "my-sc-more-btn",
        text: `Показать ещё (${nodes.length - this.renderLimit} из ${nodes.length})`,
        attr: { type: "button" },
      });
      moreBtn.onclick = () => {
        this.renderLimit += RENDER_CHUNK_SIZE;
        this.renderTree();
      };
    }

    this.treeEl.scrollTop = scrollTop;
  }

  private async setDone(item: StudyNoteItem, done: boolean) {
    try {
      await this.app.fileManager.processFrontMatter(
        item.file,
        (fm: Record<string, unknown>) => {
          fm[KEYS.status] = done ? STATUS_DONE : STATUS_ACTIVE;
        }
      );
    } catch (err: unknown) {
      new Notice("Не удалось изменить статус: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  private openMovePicker(item: StudyNoteItem) {
    const forbidden = collectDescendants(item.path, this.scan);
    forbidden.add(item.path);
    const candidates = [...this.scan.byPath.values()]
      .filter((c) => !forbidden.has(c.path) && !MATERIAL_TYPES.includes(c.noteType))
      .sort(byName);
    new ParentPickerModal(this.app, candidates, (target) => {
      void this.setParent(item, target);
    }).open();
  }

  private async setParent(item: StudyNoteItem, target: StudyNoteItem) {
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
      new Notice("Не удалось сменить родителя: " + (err instanceof Error ? err.message : String(err)));
    }
  }
}