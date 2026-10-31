import { App, FuzzySuggestModal, Modal, Notice, normalizePath } from "obsidian";
import type MyStudyCompilerPlugin from "./main";
import {
  KEYS,
  NEW_NOTE_TYPES,
  OutgoingLinkCandidate,
  QuickFilterMode,
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
  findRootPath,
  flattenVisibleTree,
  formatDeadlineBadge,
  formatFullDateTooltip,
  getDeadlineTone,
  getWorkMeta,
  scanStudyVault,
} from "./scanner";
import {
  applyOutgoingLinkCandidate,
  scanUnlinkedOutgoingLinks,
} from "./links";

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

  private linkCandidates: OutgoingLinkCandidate[] = [];
  private linksBySourcePath = new Map<string, OutgoingLinkCandidate[]>();
  private linksPanelOpen = false;
  private linksFilterSourcePath = "";
  private candidateTypeOverrides = new Map<string, string>();
  private candidateChecked = new Map<string, boolean>();

  private barEl!: HTMLElement;
  private searchWrapEl!: HTMLElement;
  private crumbsEl!: HTMLElement;
  private linksEl!: HTMLElement;
  private formEl!: HTMLElement;
  private treeEl!: HTMLElement;
  private searchInputEl: HTMLInputElement | null = null;

  private form = {
    open: false,
    title: "",
    type: "Термин",
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
    this.linksEl = this.contentEl.createDiv("my-sc-links-wrap");
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

    this.rescanVaultAndLinks();
    const addUnder = this.options.addUnder;
    if (addUnder && this.scan.byPath.has(addUnder)) {
      this.selectedPath = findRootPath(this.scan, addUnder);
      this.rescanVaultAndLinks();
    }
    const root = this.getRoot();
    if (root) {
      const savedFocus = this.plugin.settings.focusedBranchByWork[root.path];
      if (savedFocus && this.scan.byPath.has(savedFocus)) {
        this.focusBranchPath = savedFocus;
        this.rescanVaultAndLinks();
      }
    }

    this.renderAll();

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

  private rescanVaultAndLinks() {
    this.scan = scanStudyVault(this.app, this.plugin.settings);
    const root = this.getRoot();
    if (!root) {
      this.linkCandidates = [];
      this.linksBySourcePath.clear();
      return;
    }
    const branchRoot = this.getActiveBranchRoot(root);
    const found = scanUnlinkedOutgoingLinks(
      this.app,
      branchRoot,
      root,
      this.scan,
      this.plugin.settings
    );
    this.linkCandidates = found.allCandidates;
    this.linksBySourcePath = found.bySourcePath;

    if (
      this.linksFilterSourcePath &&
      !this.linksBySourcePath.has(this.linksFilterSourcePath)
    ) {
      this.linksFilterSourcePath = "";
    }
    if (this.linkCandidates.length === 0) {
      this.linksPanelOpen = false;
    }
  }

  private renderAll() {
    this.renderBar();
    this.renderSearchPanel();
    this.renderBreadcrumbs();
    this.renderLinksTray();
    this.renderTree();
  }

  private scheduleRefresh() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.rescanVaultAndLinks();
      this.renderAll();
    }, 220);
  }

  private getRoot(): StudyNoteItem | null {
    const direct = this.scan.roots.find((r) => r.path === this.selectedPath);
    if (direct) return direct;
    const first = this.scan.roots[0] ?? null;
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
    this.linksFilterSourcePath = "";
    this.rescanVaultAndLinks();
    this.renderAll();
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
    const root = this.getRoot();
    if (!root) {
      this.formEl.empty();
      this.linksEl.empty();
      this.barEl.createDiv({
        cls: "my-sc-empty",
        text: `Не найдено проектов с направлением «${this.plugin.settings.studyAreaName}» и без родителя.`,
      });
      return;
    }

    const branchRoot = this.getActiveBranchRoot(root);
    const row1 = this.barEl.createDiv("my-sc-project-select-wrap");
    const sel = row1.createEl("select", { cls: "dropdown my-sc-work-select" });
    for (const r of this.scan.roots) {
      const meta = getWorkMeta(r.noteType, r.icon);
      const o = sel.createEl("option", {
        text: `${meta.icon} ${r.name}`,
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
      this.linksPanelOpen = false;
      this.linksFilterSourcePath = "";
      this.activeRowIndex = -1;
      this.rescanVaultAndLinks();
      this.renderAll();
    };

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

    if (this.linkCandidates.length > 0) {
      const linksBtn = tools.createEl("button", {
        cls:
          "my-sc-chip-btn my-sc-links-trigger" +
          (this.linksPanelOpen ? " is-active" : ""),
        text: `🔗 Ссылки вне проекта (${this.linkCandidates.length})`,
        attr: {
          type: "button",
          title:
            "Найдены [[ссылки]] в тексте заметок, которые ещё не привязаны к этому проекту",
        },
      });
      linksBtn.onclick = () => {
        if (this.linksPanelOpen && !this.linksFilterSourcePath) {
          this.linksPanelOpen = false;
        } else {
          this.linksPanelOpen = true;
          this.linksFilterSourcePath = "";
        }
        this.renderBar();
        this.renderLinksTray();
      };
    }

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

  private renderLinksTray() {
    this.linksEl.empty();
    if (!this.linksPanelOpen || this.linkCandidates.length === 0) return;

    const root = this.getRoot();
    if (!root) return;

    const visibleList = this.linksFilterSourcePath
      ? this.linksBySourcePath.get(this.linksFilterSourcePath) ?? []
      : this.linkCandidates;

    if (visibleList.length === 0) {
      this.linksPanelOpen = false;
      return;
    }

    const defaultType = this.plugin.settings.defaultLinkNoteType || "Термин";
    for (const c of visibleList) {
      if (!this.candidateTypeOverrides.has(c.id)) {
        this.candidateTypeOverrides.set(c.id, defaultType);
      }
      if (!this.candidateChecked.has(c.id)) {
        // Заметки с другим родителем по умолчанию не отмечаем галочкой для пакетного добавления, чтобы пользователь решил сам
        this.candidateChecked.set(c.id, c.kind !== "has-other-parent");
      }
    }

    const tray = this.linksEl.createDiv("my-sc-links-tray");
    const head = tray.createDiv("my-sc-links-head");

    const titleSpan = head.createDiv("my-sc-links-title");
    if (this.linksFilterSourcePath) {
      const srcItem = this.scan.byPath.get(this.linksFilterSourcePath);
      titleSpan.setText(
        `🔗 Непривязанные [[ссылки]] в заметке «${srcItem?.name ?? ""}» (${visibleList.length})`
      );
    } else {
      titleSpan.setText(
        `🔗 Обнаружены [[ссылки]] в тексте без привязки к проекту (${visibleList.length})`
      );
    }

    const headActions = head.createDiv("my-sc-links-head-actions");
    if (this.linksFilterSourcePath) {
      const showAllBtn = headActions.createEl("button", {
        cls: "my-sc-chip-btn",
        text: `Показать все (${this.linkCandidates.length})`,
        attr: { type: "button" },
      });
      showAllBtn.onclick = () => {
        this.linksFilterSourcePath = "";
        this.renderLinksTray();
      };
    }

    const batchBtn = headActions.createEl("button", {
      cls: "mod-cta my-sc-action-btn",
      text: "✓ Привязать выбранные",
      attr: { type: "button" },
    });

    const closeTrayBtn = headActions.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "✕",
      attr: { type: "button", title: "Скрыть панель ссылок" },
    });
    closeTrayBtn.onclick = () => {
      this.linksPanelOpen = false;
      this.linksFilterSourcePath = "";
      this.renderBar();
      this.renderLinksTray();
    };

    const listEl = tray.createDiv("my-sc-links-list");

    for (const cand of visibleList) {
      const row = listEl.createDiv("my-sc-link-row");
      const left = row.createDiv("my-sc-link-left");

      const chk = left.createEl("input", {
        attr: { type: "checkbox", title: "Выбрать для пакетного добавления" },
      });
      chk.checked = Boolean(this.candidateChecked.get(cand.id));
      chk.onchange = () => {
        this.candidateChecked.set(cand.id, chk.checked);
      };

      const infoCol = left.createDiv("my-sc-link-info");
      const mainLine = infoCol.createDiv("my-sc-link-main");
      mainLine.createSpan({
        cls: "my-sc-link-target",
        text: `[[${cand.targetName}]]`,
      });
      mainLine.createSpan({
        cls: "my-sc-link-arrow",
        text: `← из «${cand.sourceName}»`,
      });

      const statusBadge = infoCol.createSpan({
        cls: `my-sc-link-status is-${cand.kind}`,
      });
      if (cand.kind === "missing") {
        statusBadge.setText("✨ Файла ещё нет — будет создан в папке «Знания»");
      } else if (cand.kind === "existing-free") {
        statusBadge.setText("📄 Заметка существует (без родителя) — пропишем родителя");
      } else {
        const parentNames = cand.existingParents
          .map((p) => p.split("/").pop()?.replace(/\.md$/i, "") || p)
          .join(", ");
        statusBadge.setText(
          `⚠️ Уже есть родитель (${parentNames}) — добавим вторым родителем без перезаписи`
        );
      }

      const right = row.createDiv("my-sc-link-right");
      const typeSel = right.createEl("select", {
        cls: "dropdown my-sc-link-type-sel",
        attr: { title: "Тип для этой заметки" },
      });
      const currentType =
        this.candidateTypeOverrides.get(cand.id) || defaultType;
      for (const t of NEW_NOTE_TYPES) {
        const o = typeSel.createEl("option", { text: t, value: t });
        if (t === currentType) o.selected = true;
      }
      typeSel.onchange = () => {
        this.candidateTypeOverrides.set(cand.id, typeSel.value);
      };

      const singleBtn = right.createEl("button", {
        cls: "my-sc-chip-btn",
        text:
          cand.kind === "missing"
            ? "＋ Создать"
            : cand.kind === "has-other-parent"
              ? "＋ Привязать вторым"
              : "＋ В проект",
        attr: { type: "button" },
      });
      singleBtn.onclick = async () => {
        singleBtn.disabled = true;
        try {
          const chosenType =
            this.candidateTypeOverrides.get(cand.id) || defaultType;
          await applyOutgoingLinkCandidate(
            this.app,
            cand,
            chosenType,
            root,
            this.plugin.settings
          );
          this.expanded.add(cand.sourcePath);
          this.saveExpanded();
          new Notice(`Привязано: «${cand.targetName}» → «${cand.sourceName}»`);
          this.rescanVaultAndLinks();
          this.renderAll();
        } catch (err: unknown) {
          new Notice(
            "Ошибка привязки: " +
              (err instanceof Error ? err.message : String(err))
          );
          singleBtn.disabled = false;
        }
      };
    }

    batchBtn.onclick = async () => {
      const toApply = visibleList.filter((c) => this.candidateChecked.get(c.id));
      if (toApply.length === 0) {
        new Notice("Отметь галочками хотя бы одну ссылку.");
        return;
      }
      batchBtn.disabled = true;
      let count = 0;
      for (const cand of toApply) {
        try {
          const chosenType =
            this.candidateTypeOverrides.get(cand.id) || defaultType;
          await applyOutgoingLinkCandidate(
            this.app,
            cand,
            chosenType,
            root,
            this.plugin.settings
          );
          this.expanded.add(cand.sourcePath);
          count++;
        } catch {
          // пропускаем проблемный файл и продолжаем пакет
        }
      }
      this.saveExpanded();
      new Notice(`Добавлено в проект материалов: ${count}`);
      this.rescanVaultAndLinks();
      this.renderAll();
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
      this.renderTree();
    };

    const typeSel = row.createEl("select", {
      cls: "dropdown my-sc-type-filter",
      attr: { title: "Фильтр по типу материала" },
    });
    typeSel.createEl("option", { text: "Все типы", value: "" });
    for (const t of NEW_NOTE_TYPES) {
      const o = typeSel.createEl("option", { text: t, value: t });
      if (t === this.typeFilter) o.selected = true;
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
      attr: { type: "text", placeholder: "Название темы или материала…" },
    });
    titleInp.value = this.form.title;
    titleInp.oninput = () => {
      this.form.title = titleInp.value;
    };

    const parentSel = box.createEl("select", { cls: "dropdown my-sc-parent-select" });
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
    this.safeClose();
    void this.app.workspace.openLinkText(path, "", false);
  }

  private renderTree() {
    const scrollTop = this.treeEl.scrollTop;
    this.treeEl.empty();
    this.rowElementByPath.clear();
    const root = this.getRoot();
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

    const nodeUnlinked = this.linksBySourcePath.get(item.path);
    if (nodeUnlinked && nodeUnlinked.length > 0) {
      const linkPill = right.createEl("button", {
        cls: "my-sc-unlinked-pill",
        text: `🔗 +${nodeUnlinked.length}`,
        attr: {
          type: "button",
          title: `В тексте «${item.name}» найдено непривязанных ссылок: ${nodeUnlinked.length}. Нажми, чтобы добавить их в проект`,
        },
      });
      linkPill.onclick = (e) => {
        e.stopPropagation();
        this.linksPanelOpen = true;
        this.linksFilterSourcePath = item.path;
        this.renderBar();
        this.renderLinksTray();
      };
    }

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

    if (node.isExpanded && node.children.length > 0) {
      const childrenWrap = groupEl.createDiv("my-sc-children-container");
      for (const child of node.children) {
        this.renderNodeGroup(childrenWrap, child, projectRoot);
      }
    }
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