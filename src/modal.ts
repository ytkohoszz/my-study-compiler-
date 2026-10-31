import { App, FuzzySuggestModal, Modal, Notice, normalizePath } from "obsidian";
import type MyStudyCompilerPlugin from "./main";
import {
  CustomPropertyDraft,
  KEYS,
  ProjectGroupTab,
  QuickFilterMode,
  ROOT_STATUS_ACTIVE,
  ROOT_STATUS_DONE,
  StudyNoteItem,
  TreeNode,
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
  normalizeSpaces,
  parseCustomPropertyValue,
  scanStudyVault,
  serializeYamlScalarOrList,
  todayISO,
} from "./scanner";

export interface OpenOptions {
  rootPath?: string;
  addUnder?: string;
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

export class StudyCompilerModal extends Modal {
  private plugin: MyStudyCompilerPlugin;
  private options: OpenOptions;
  private scan: ScanResult = emptyScan();
  private groupTab: ProjectGroupTab;
  private selectedPath: string;
  private focusBranchPath = "";
  private expanded: Set<string>;
  private cleanups: Array<() => void> = [];
  private refreshTimer: number | null = null;

  private searchQuery = "";
  private filterMode: QuickFilterMode = "all";
  private typeFilter = "";
  private activeRowIndex = -1;
  private currentVisibleFlat: TreeNode[] = [];
  private rowElementByPath = new Map<string, HTMLElement>();

  // Быстрое редактирование типа или свойств конкретного узла дерева
  private editingNodePath: string | null = null;
  private editingNodeMode: "type" | "props" | null = null;

  private barEl!: HTMLElement;
  private searchWrapEl!: HTMLElement;
  private crumbsEl!: HTMLElement;
  private formEl!: HTMLElement;
  private treeEl!: HTMLElement;
  private datalistsEl!: HTMLElement;
  private searchInputEl: HTMLInputElement | null = null;

  private form: {
    open: boolean;
    title: string;
    type: string;
    parentPath: string;
    deadline: string;
    customProps: CustomPropertyDraft[];
  };

  constructor(app: App, plugin: MyStudyCompilerPlugin, options: OpenOptions = {}) {
    super(app);
    this.plugin = plugin;
    this.options = options;
    this.groupTab = plugin.settings.projectGroupTab || "active";
    this.selectedPath = options.rootPath || plugin.settings.lastWorkPath;
    this.expanded = new Set(plugin.settings.expandedPaths);
    this.form = {
      open: false,
      title: "",
      type: plugin.settings.lastUsedMaterialType || "Термин",
      parentPath: "",
      deadline: "",
      customProps: [],
    };
    this.noRestore();
  }

  private noRestore() {
    (this as unknown as { shouldRestoreSelection?: boolean }).shouldRestoreSelection = false;
  }

  onOpen(): void {
    this.noRestore();
    this.modalEl.addClass("my-sc-modal-container");
    this.contentEl.addClass("my-sc-modal");

    // Только заголовок с отступом справа под родной крестик Obsidian (.modal-close-button)
    const head = this.contentEl.createDiv("my-sc-head-bar");
    head.createDiv({ cls: "my-sc-head-title", text: "🎓 Проекты и рабочее дерево" });

    this.datalistsEl = this.contentEl.createDiv("my-sc-datalists-host");
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

    // Если выбранный/запомненный проект находится в другой вкладке (Активные/Завершённые), переключаемся туда автоматически
    this.syncGroupTabWithSelectedProject();

    const root = this.getRootInCurrentGroup();
    if (root) {
      const savedFocus = this.plugin.settings.focusedBranchByWork[root.path];
      if (savedFocus && this.scan.byPath.has(savedFocus)) {
        this.focusBranchPath = savedFocus;
      }
    }

    this.renderDatalists();
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

  private syncGroupTabWithSelectedProject() {
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

  private scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.scan = scanStudyVault(this.app, this.plugin.settings);
      this.renderDatalists();
      this.renderBar();
      this.renderSearchPanel();
      this.renderBreadcrumbs();
      if (this.form.open) this.renderForm();
      this.renderTree();
    }, 220);
  }

  private renderDatalists() {
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

  private setFocusBranch(projectRoot: StudyNoteItem, branchPath: string) {
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
        this.openNote(picked.item.path);
      }
    } else if (
      (e.key === "ArrowRight" || e.key === "ArrowLeft") &&
      activeEl !== this.searchInputEl &&
      this.activeRowIndex >= 0
    ) {
      const picked = this.currentVisibleFlat[this.activeRowIndex];
      if (!picked || !picked.hasChildren) return;
      e.preventDefault();
      if (e.key === "ArrowRight") this.expanded.add(picked.item.path);
      else this.expanded.delete(picked.item.path);
      this.saveExpanded();
      this.renderTree();
    }
  }

  private highlightActiveRow() {
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

  private renderBar() {
    this.barEl.empty();

    // 1. Сегмент-переключатель «Активные · N / Завершённые · M»
    const segRow = this.barEl.createDiv("my-sc-segment-bar");
    const activeCount = this.scan.activeRoots.length;
    const completedCount = this.scan.completedRoots.length;

    const segments: Array<{ id: ProjectGroupTab; label: string }> = [
      { id: "active", label: `🔥 Активные · ${activeCount}` },
      { id: "completed", label: `✓ Завершённые · ${completedCount}` },
    ];

    for (const seg of segments) {
      const btn = segRow.createEl("button", {
        cls: "my-sc-segment-btn" + (this.groupTab === seg.id ? " is-active" : ""),
        text: seg.label,
        attr: { type: "button" },
      });
      btn.onclick = () => {
        if (this.groupTab === seg.id) return;
        this.groupTab = seg.id;
        this.plugin.settings.projectGroupTab = seg.id;
        const firstInGroup = this.getRootsForTab(seg.id)[0];
        this.selectedPath = firstInGroup ? firstInGroup.path : "";
        if (firstInGroup) {
          this.plugin.settings.lastWorkPath = firstInGroup.path;
          this.focusBranchPath =
            this.plugin.settings.focusedBranchByWork[firstInGroup.path] || "";
        } else {
          this.focusBranchPath = "";
        }
        this.plugin.requestSaveSettings();
        this.form.open = false;
        this.formEl.empty();
        this.activeRowIndex = -1;
        this.renderBar();
        this.renderBreadcrumbs();
        this.renderTree();
      };
    }

    const root = this.getRootInCurrentGroup();
    if (!root) {
      this.formEl.empty();
      const emptyBox = this.barEl.createDiv("my-sc-empty-group-box");
      if (this.groupTab === "active" && completedCount > 0) {
        emptyBox.createSpan({
          text: `Активных проектов сейчас нет (в завершённых: ${completedCount}). `,
        });
        const switchBtn = emptyBox.createEl("button", {
          cls: "my-sc-chip-btn",
          text: "Показать завершённые",
          attr: { type: "button" },
        });
        switchBtn.onclick = () => {
          this.groupTab = "completed";
          this.plugin.settings.projectGroupTab = "completed";
          this.plugin.requestSaveSettings();
          this.renderBar();
          this.renderBreadcrumbs();
          this.renderTree();
        };
      } else if (this.groupTab === "completed" && activeCount > 0) {
        emptyBox.createSpan({
          text: `Завершённых проектов пока нет (активных: ${activeCount}).`,
        });
      } else {
        emptyBox.setText(
          `Не найдено проектов с направлением «${this.plugin.settings.studyAreaName}» и без родителя.`
        );
      }
      return;
    }

    const branchRoot = this.getActiveBranchRoot(root);
    const groupRoots = this.getRootsForTab(this.groupTab);

    const row1 = this.barEl.createDiv("my-sc-project-select-wrap");
    const sel = row1.createEl("select", { cls: "dropdown my-sc-work-select" });
    for (const r of groupRoots) {
      const meta = getWorkMeta(r.noteType, r.icon);
      const dlText = r.deadline && !r.isCompletedRoot ? ` · ${formatDeadlineBadge(r)}` : "";
      const o = sel.createEl("option", {
        text: `${meta.icon} ${r.name} (${r.noteType || "Проект"})${dlText}`,
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

    const toggleRootStatusBtn = row1.createEl("button", {
      cls: "my-sc-chip-btn",
      text: root.isCompletedRoot ? "↩ В работу" : "✓ Завершить проект",
      attr: {
        type: "button",
        title: root.isCompletedRoot
          ? "Вернуть корневой проект в список активных"
          : "Перевести корневой проект в завершённые",
      },
    });
    toggleRootStatusBtn.onclick = () => void this.toggleRootProjectStatus(root);

    const openBtn = row1.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "📄 Открыть",
      attr: { type: "button", title: "Открыть заметку текущей ветки или проекта" },
    });
    openBtn.onclick = () => this.openNote(branchRoot.path);

    const descendants = collectDescendants(branchRoot.path, this.scan);
    const directKidsCount = (this.scan.childrenOf.get(branchRoot.path) ?? []).length;
    const summaryRow = this.barEl.createDiv("my-sc-summary-row");
    const scopePrefix =
      branchRoot.path !== root.path ? `Ветка «${branchRoot.name}»: ` : "";
    summaryRow.createSpan({
      cls: "my-sc-summary-text",
      text:
        descendants.size > 0
          ? `${scopePrefix}материалов в дереве — ${descendants.size} (разделов 1-го уровня: ${directKidsCount})`
          : `${scopePrefix}материалов пока нет`,
    });
    this.renderDeadline(summaryRow, branchRoot);

    const tools = this.barEl.createDiv("my-sc-tools");
    const addBtn = tools.createEl("button", {
      cls: "my-sc-chip-btn" + (this.form.open ? " is-active" : ""),
      text: this.form.open ? "✕ Закрыть форму" : "＋ Добавить материал",
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
      text: "⤢ Развернуть всё",
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
      text: "⤡ Свернуть всё",
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

  private async toggleRootProjectStatus(root: StudyNoteItem) {
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
      this.renderTree();
    };

    const typeSel = row.createEl("select", {
      cls: "dropdown my-sc-type-filter",
      attr: { title: "Фильтр по типу из хранилища" },
    });
    typeSel.createEl("option", { text: "Все типы", value: "" });
    for (const t of this.scan.schema.typeCounts) {
      const o = typeSel.createEl("option", {
        text: `${t.name} (${t.count})`,
        value: t.name,
      });
      if (t.name.toLowerCase() === this.typeFilter.toLowerCase()) {
        o.selected = true;
      }
    }
    typeSel.onchange = () => {
      this.typeFilter = typeSel.value;
      this.activeRowIndex = -1;
      this.renderTree();
    };

    if (this.scan.orphans.length > 0 || this.filterMode === "orphans") {
      const chipsRow = this.searchWrapEl.createDiv("my-sc-filter-chips");
      const modes: Array<{ id: QuickFilterMode; label: string }> = [
        { id: "all", label: "🌳 Дерево проекта" },
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
          this.filterMode =
            this.filterMode === m.id && m.id !== "all" ? "all" : m.id;
          this.activeRowIndex = -1;
          this.renderSearchPanel();
          this.renderTree();
        };
      }
    }
  }

  private renderBreadcrumbs() {
    this.crumbsEl.empty();
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
    const root = this.getRootInCurrentGroup();
    if (!root) return;
    this.form.open = true;
    this.form.type =
      this.plugin.settings.lastUsedMaterialType ||
      this.scan.schema.typeCounts[0]?.name ||
      "Термин";
    this.form.parentPath = this.scan.byPath.has(parentPath) ? parentPath : root.path;
    this.renderBar();
    this.renderForm();
  }

  private renderForm() {
    this.formEl.empty();
    if (!this.form.open) return;
    const root = this.getRootInCurrentGroup();
    if (!root) return;

    const box = this.formEl.createDiv("my-sc-add-box");
    const topRow = box.createDiv("my-sc-form-row");

    // 3.1. Свободное поле «Тип» с подсказками из реальных типов хранилища
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

    // Быстрые чипы самых частых типов
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
          this.renderForm();
        };
      }
    }

    // 3.2. Произвольные свойства при создании
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
        const vals = this.scan.schema.valuesByKey.get(normalizeSpaces(kName)) ?? [];
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

      const delBtn = pRow.createEl("button", {
        cls: "my-sc-move-btn",
        text: "✕",
        attr: { type: "button", title: "Удалить свойство" },
      });
      delBtn.onclick = () => {
        this.form.customProps.splice(i, 1);
        this.renderForm();
      };
    }

    const actionsRow = box.createDiv("my-sc-form-actions");
    const addPropBtn = actionsRow.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "＋ Свойство",
      attr: { type: "button" },
    });
    addPropBtn.onclick = () => {
      this.form.customProps.push({
        id: String(Date.now() + Math.random()),
        key: "",
        value: "",
        kind: "auto",
      });
      this.renderForm();
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
    const cleanTitle = normalizeSpaces(this.form.title).replace(/[\\/:*?"<>|]/g, "");
    if (!cleanTitle) {
      new Notice("Введи название материала.");
      return false;
    }

    const normalizedType = normalizeSpaces(this.form.type) || "Материал";

    // Валидация произвольных свойств перед созданием файла
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
        new Notice("Укажи имя ключа для добавленного свойства или удали пустую строку.");
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
        new Notice(`Дублирующийся ключ свойства «${k}». Оставь только одно поле.`);
        return false;
      }
      if (parsedVal === undefined) continue; // Пустые значения не записываем совсем

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
        title: formatFullDateTooltip(item.deadline),
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
    this.noRestore();
    this.close();
    void this.app.workspace.openLinkText(path, "", false);
  }

  private renderTree() {
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
          ? "По текущему запросу или фильтру ничего не найдено."
          : "В этой ветке пока нет материалов. Нажми «＋ Добавить материал».",
      });
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
  }

  private renderNodeGroup(
    parentContainer: HTMLElement,
    node: TreeNode,
    projectRoot: StudyNoteItem
  ) {
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
        (node.isDirectMatch ? " is-match" : ""),
    });
    this.rowElementByPath.set(item.path, row);

    const left = row.createDiv("my-sc-tree-left");

    if (node.hasChildren) {
      const toggleBtn = left.createEl("button", {
        cls: "my-sc-toggle-btn" + (node.isExpanded ? " is-open" : ""),
        text: "▸",
        attr: {
          type: "button",
          title: node.isExpanded ? "Свернуть ветку" : "Развернуть ветку",
          "aria-label": node.isExpanded ? "Свернуть ветку" : "Развернуть ветку",
          "aria-expanded": String(node.isExpanded),
        },
      });
      toggleBtn.onclick = (e) => {
        e.stopPropagation();
        if (this.expanded.has(item.path)) this.expanded.delete(item.path);
        else this.expanded.add(item.path);
        this.saveExpanded();
        this.renderTree();
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
    title.onclick = () => this.openNote(item.path);

    // Кликабельный бейдж типа: позволяет быстро сменить тип существующей заметки прямо из дерева
    const meta = getWorkMeta(item.noteType, item.icon);
    const badge = left.createEl("button", {
      cls: "my-sc-type-badge",
      text: `${meta.icon} ${item.noteType || "без типа"}`,
      attr: {
        type: "button",
        title: "Нажми, чтобы изменить тип заметки",
      },
    });
    badge.style.setProperty("--badge-color", meta.color);
    badge.onclick = (e) => {
      e.stopPropagation();
      if (this.editingNodePath === item.path && this.editingNodeMode === "type") {
        this.editingNodePath = null;
        this.editingNodeMode = null;
      } else {
        this.editingNodePath = item.path;
        this.editingNodeMode = "type";
      }
      this.renderTree();
    };

    if (item.parentPaths.length > 1) {
      left.createSpan({
        cls: "my-sc-multi-parent",
        text: `×${item.parentPaths.length}`,
        attr: { title: `Привязана к ${item.parentPaths.length} родителям` },
      });
    }

    const right = row.createDiv("my-sc-tree-right");
    this.renderDeadline(right, item);

    if (node.hasChildren) {
      const countPill = right.createEl("button", {
        cls:
          "my-sc-subcount-pill" +
          (node.isExpanded ? " is-expanded" : " is-collapsed"),
        text: node.isExpanded
          ? `▾ ${node.descendantCount}`
          : `+${node.descendantCount} внутри`,
        attr: {
          type: "button",
          title: node.isExpanded
            ? `Вложено элементов в ветке: ${node.descendantCount} (нажми, чтобы свернуть)`
            : `Скрыто вложенных элементов: ${node.descendantCount} (нажми, чтобы раскрыть)`,
        },
      });
      countPill.onclick = (e) => {
        e.stopPropagation();
        if (this.expanded.has(item.path)) this.expanded.delete(item.path);
        else this.expanded.add(item.path);
        this.saveExpanded();
        this.renderTree();
      };

      const focusBtn = right.createEl("button", {
        cls: "my-sc-move-btn",
        text: "🎯",
        attr: { type: "button", title: "Сфокусироваться только на этой ветке" },
      });
      focusBtn.onclick = () => this.setFocusBranch(projectRoot, item.path);
    }

    const propEditBtn = right.createEl("button", {
      cls:
        "my-sc-move-btn" +
        (this.editingNodePath === item.path && this.editingNodeMode === "props"
          ? " is-active"
          : ""),
      text: "⚙",
      attr: {
        type: "button",
        title: "Изменить тип или добавить/обновить YAML-свойство заметки",
      },
    });
    propEditBtn.onclick = (e) => {
      e.stopPropagation();
      if (this.editingNodePath === item.path && this.editingNodeMode === "props") {
        this.editingNodePath = null;
        this.editingNodeMode = null;
      } else {
        this.editingNodePath = item.path;
        this.editingNodeMode = "props";
      }
      this.renderTree();
    };

    const addBtn = right.createEl("button", {
      cls: "my-sc-move-btn",
      text: "＋",
      attr: { type: "button", title: "Добавить вложенный материал сюда" },
    });
    addBtn.onclick = () => this.openForm(item.path);

    const moveBtn = right.createEl("button", {
      cls: "my-sc-move-btn",
      text: "⇄",
      attr: { type: "button", title: "Сменить родителя" },
    });
    moveBtn.onclick = () => this.openMovePicker(item);

    // Компактная панель быстрого изменения типа или свойства у существующей заметки
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

  private renderInlineNodeEditor(parentGroup: HTMLElement, item: StudyNoteItem) {
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
      };
      inp.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") void applyType();
      });
      window.setTimeout(() => inp.focus(), 20);
      return;
    }

    // Режим добавления/обновления произвольного свойства у существующей заметки
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
    };
    window.setTimeout(() => keyInp.focus(), 20);
  }

  private openMovePicker(item: StudyNoteItem) {
    const forbidden = collectDescendants(item.path, this.scan);
    forbidden.add(item.path);
    const candidates = [...this.scan.byPath.values()]
      .filter((c) => !forbidden.has(c.path))
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