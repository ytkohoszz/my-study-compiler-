import { App, FuzzySuggestModal, Modal, Notice, normalizePath } from "obsidian";
import type MyStudyCompilerPlugin from "./main";
import {
  KEYS,
  MATERIAL_TYPES,
  NEW_NOTE_TYPES,
  STATUS_ACTIVE,
  STATUS_DONE,
  StudyNoteItem,
} from "./types";
import {
  ScanResult,
  buildTree,
  byName,
  collectDescendants,
  emptyScan,
  ensureFolder,
  findRootPath,
  formatDeadline,
  getWorkMeta,
  progressOf,
  scanStudyVault,
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
    this.setPlaceholder("Новый родитель…");
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
  private expanded: Set<string>;
  private cleanups: Array<() => void> = [];
  private refreshTimer: number | null = null;

  private barEl!: HTMLElement;
  private formEl!: HTMLElement;
  private treeEl!: HTMLElement;

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
    head.createDiv({ cls: "my-sc-head-title", text: "🎓 Проекты и подпроекты" });
    const closeBtn = head.createEl("button", {
      cls: "my-sc-close-btn",
      text: "✕",
      attr: { type: "button", title: "Закрыть (Esc)", "aria-label": "Закрыть" },
    });
    closeBtn.onclick = () => this.safeClose();

    this.barEl = this.contentEl.createDiv("my-sc-project-bar");
    this.formEl = this.contentEl.createDiv("my-sc-form-wrap");
    this.treeEl = this.contentEl.createDiv("my-sc-body");

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
    this.refresh(false);
    if (addUnder && this.scan.byPath.has(addUnder)) this.openForm(addUnder);
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
      this.refresh(true);
    }, 200);
  }

  private refresh(rescan: boolean) {
    if (rescan) this.scan = scanStudyVault(this.app, this.plugin.settings);
    this.renderBar();
    this.renderTree();
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

  private saveExpanded() {
    this.plugin.settings.expandedPaths = [...this.expanded];
    this.plugin.requestSaveSettings();
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
      this.plugin.requestSaveSettings();
      this.form.open = false;
      this.formEl.empty();
      this.refresh(false);
    };

    const doneBtn = row1.createEl("button", {
      cls: "my-sc-chip-btn" + (this.plugin.settings.showCompletedWorks ? " is-active" : ""),
      text: this.plugin.settings.showCompletedWorks ? "✓ Все проекты" : "В работе",
      attr: { type: "button", title: "Показывать завершённые проекты" },
    });
    doneBtn.onclick = () => {
      this.plugin.settings.showCompletedWorks = !this.plugin.settings.showCompletedWorks;
      this.plugin.requestSaveSettings();
      this.refresh(false);
    };

    const openBtn = row1.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "📄 Открыть",
      attr: { type: "button", title: "Открыть заметку проекта" },
    });
    openBtn.onclick = () => this.openNote(root.path);

    const stats = progressOf(collectDescendants(root.path, this.scan), this.scan);
    const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
    const progWrap = this.barEl.createDiv("my-sc-progress-wrap");
    const progText = progWrap.createDiv("my-sc-progress-text");
    progText.createSpan({
      text: stats.total > 0 ? `Выполнено ${stats.done} из ${stats.total} · ${pct}%` : "Подпроектов пока нет",
    });
    this.renderDeadline(progText, root);
    const bar = progWrap.createDiv("my-sc-progress");
    bar.createDiv("my-sc-progress-fill").style.width = `${pct}%`;

    const tools = this.barEl.createDiv("my-sc-tools");
    const addBtn = tools.createEl("button", {
      cls: "my-sc-chip-btn" + (this.form.open ? " is-active" : ""),
      text: this.form.open ? "✕ Закрыть форму" : "＋ Подпроект",
      attr: { type: "button" },
    });
    addBtn.onclick = () => {
      if (this.form.open) {
        this.form.open = false;
        this.formEl.empty();
        this.renderBar();
      } else {
        this.openForm(root.path);
      }
    };

    const expandBtn = tools.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "⤢ Развернуть всё",
      attr: { type: "button" },
    });
    expandBtn.onclick = () => {
      for (const p of collectDescendants(root.path, this.scan)) {
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
      for (const p of collectDescendants(root.path, this.scan)) this.expanded.delete(p);
      this.saveExpanded();
      this.renderTree();
    };
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
      attr: { type: "text", placeholder: "Название…" },
    });
    titleInp.value = this.form.title;
    titleInp.oninput = () => {
      this.form.title = titleInp.value;
    };

    const parentSel = box.createEl("select", { cls: "dropdown my-sc-parent-select" });
    parentSel.createEl("option", { text: `↳ ${root.name}`, value: root.path });
    for (const n of buildTree(root, this.scan, null)) {
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
    const overdue = !item.isDone && item.deadline < todayISO();
    parent.createSpan({
      cls: "my-sc-deadline" + (overdue ? " is-overdue" : ""),
      text: `⏳ ${formatDeadline(item.deadline)}`,
      attr: { title: overdue ? "Срок прошёл" : "Дедлайн" },
    });
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

    const nodes = buildTree(root, this.scan, this.expanded);
    if (nodes.length === 0) {
      this.treeEl.createDiv({
        cls: "my-sc-empty",
        text: "Подпроектов пока нет. Нажми «＋ Подпроект».",
      });
      return;
    }

    const list = this.treeEl.createDiv("my-sc-tree-list");
    for (const node of nodes) {
      const item = node.item;
      const row = list.createDiv("my-sc-tree-row" + (item.isDone ? " is-done" : ""));
      row.style.paddingLeft = `${8 + node.depth * 18}px`;

      const left = row.createDiv("my-sc-tree-left");

      if (node.hasChildren) {
        const open = this.expanded.has(item.path);
        const arrow = left.createEl("button", {
          cls: "my-sc-arrow",
          text: open ? "▾" : "▸",
          attr: { type: "button", "aria-label": open ? "Свернуть" : "Развернуть" },
        });
        arrow.onclick = () => {
          if (open) this.expanded.delete(item.path);
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
        text: item.name,
        attr: { title: "Открыть заметку" },
      });
      title.onclick = () => this.openNote(item.path);

      const meta = getWorkMeta(item.noteType, item.icon);
      const badge = left.createSpan({
        cls: "my-sc-type-badge",
        text: `${meta.icon} ${item.noteType || "без типа"}`,
      });
      badge.style.setProperty("--badge-color", meta.color);

      const right = row.createDiv("my-sc-tree-right");
      this.renderDeadline(right, item);
      if (node.total > 0) {
        right.createSpan({
          cls: "my-sc-branch-count",
          text: `${node.done}/${node.total}`,
          attr: { title: "Выполнено в ветке" },
        });
      }

      const addBtn = right.createEl("button", {
        cls: "my-sc-move-btn",
        text: "＋",
        attr: { type: "button", title: "Добавить подпроект сюда" },
      });
      addBtn.onclick = () => this.openForm(item.path);

      const moveBtn = right.createEl("button", {
        cls: "my-sc-move-btn",
        text: "⇄",
        attr: { type: "button", title: "Сменить родителя" },
      });
      moveBtn.onclick = () => this.openMovePicker(item);
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