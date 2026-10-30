import { App, Modal, Notice, normalizePath } from "obsidian";
import type MyStudyCompilerPlugin from "./main";
import {
  CompilationResult,
  DEFAULT_COMPILE_CONFIG,
  HierarchyNode,
  MATERIAL_TYPES,
  ProjectCompileConfig,
  StudyNoteItem,
  TYPE_COLORS,
} from "./types";
import {
  buildProjectHierarchy,
  getWorkMeta,
  scanStudyVault,
} from "./scanner";
import {
  buildAuditAndCompileProject,
  ensureVaultFolderExists,
  writeCompiledFileToVault,
} from "./compiler";

type CompilerTab = "structure" | "audit" | "preview";

export class StudyCompilerModal extends Modal {
  plugin: MyStudyCompilerPlugin;
  selectedWorkPath = "";
  activeTab: CompilerTab = "structure";

  works: StudyNoteItem[] = [];
  byPath = new Map<string, StudyNoteItem>();
  childrenOf = new Map<string, string[]>();

  rootBodyText = "";
  rootWords = 0;
  nodes: HierarchyNode[] = [];
  compiled: CompilationResult | null = null;

  isAddingSectionOpen = false;
  newSectionTitle = "";
  newSectionType = "Конспект";
  newSectionParentPath = "";

  constructor(app: App, plugin: MyStudyCompilerPlugin, initialWorkPath?: string) {
    super(app);
    (
      this as unknown as { shouldRestoreSelection?: boolean }
    ).shouldRestoreSelection = false;
    this.plugin = plugin;
    if (initialWorkPath) {
      this.selectedWorkPath = initialWorkPath;
    }
  }

  safeClose() {
    try {
      (
        this as unknown as { shouldRestoreSelection?: boolean }
      ).shouldRestoreSelection = false;
      this.close();
    } catch {
      // Игнорируем
    }
  }

  async onOpen() {
    (
      this as unknown as { shouldRestoreSelection?: boolean }
    ).shouldRestoreSelection = false;
    this.modalEl.addClass("my-sc-modal-container");
    this.contentEl.addClass("my-sc-modal");

    await this.reloadVaultAndRebuild();
  }

  onClose() {
    this.contentEl.empty();
  }

  private getActiveWork(): StudyNoteItem | null {
    if (!this.works.length) return null;
    const found = this.works.find((w) => w.path === this.selectedWorkPath);
    if (found) return found;
    const first = this.works[0] ?? null;
    if (first) this.selectedWorkPath = first.path;
    return first;
  }

  private getConfigForWork(workPath: string): ProjectCompileConfig {
    const existing = this.plugin.settings.projectConfigs[workPath];
    if (existing) {
      return {
        ...DEFAULT_COMPILE_CONFIG,
        ...existing,
        orderedPaths: Array.isArray(existing.orderedPaths)
          ? [...existing.orderedPaths]
          : [],
        excludedPaths: Array.isArray(existing.excludedPaths)
          ? [...existing.excludedPaths]
          : [],
      };
    }
    const fresh: ProjectCompileConfig = {
      ...DEFAULT_COMPILE_CONFIG,
      orderedPaths: [],
      excludedPaths: [],
    };
    this.plugin.settings.projectConfigs[workPath] = fresh;
    return fresh;
  }

  private saveConfigForWork(workPath: string, cfg: ProjectCompileConfig) {
    this.plugin.settings.projectConfigs[workPath] = cfg;
    this.plugin.requestSaveSettings();
  }

  async reloadVaultAndRebuild() {
    const scanned = scanStudyVault(this.app, this.plugin.settings);
    this.works = scanned.works;
    this.byPath = scanned.byPath;
    this.childrenOf = scanned.childrenOf;

    const activeWork = this.getActiveWork();
    if (!activeWork) {
      this.nodes = [];
      this.compiled = null;
      this.render();
      return;
    }

    const cfg = this.getConfigForWork(activeWork.path);
    const built = await buildProjectHierarchy(
      this.app,
      activeWork,
      this.byPath,
      this.childrenOf,
      cfg
    );
    this.rootBodyText = built.rootBodyText;
    this.rootWords = built.rootWords;
    this.nodes = built.nodes;

    // Синхронизируем массив orderedPaths с текущим деревом
    const currentOrder = this.nodes.map((n) => n.item.path);
    cfg.orderedPaths = currentOrder;
    this.saveConfigForWork(activeWork.path, cfg);

    this.compiled = buildAuditAndCompileProject(
      activeWork,
      this.rootBodyText,
      this.nodes,
      cfg,
      this.plugin.settings.outputFolder
    );

    this.render();
  }

  private async moveNodeInSiblingGroup(node: HierarchyNode, delta: -1 | 1) {
    const activeWork = this.getActiveWork();
    if (!activeWork) return;

    const siblings = this.nodes.filter(
      (n) => n.parentPath === node.parentPath && n.depth === node.depth
    );
    const idxInSiblings = siblings.findIndex(
      (s) => s.item.path === node.item.path
    );
    const targetSibling = siblings[idxInSiblings + delta];
    if (idxInSiblings === -1 || !targetSibling) return;

    const cfg = this.getConfigForWork(activeWork.path);
    const list = [...this.nodes.map((n) => n.item.path)];
    const iA = list.indexOf(node.item.path);
    const iB = list.indexOf(targetSibling.item.path);
    if (iA === -1 || iB === -1) return;

    list[iA] = targetSibling.item.path;
    list[iB] = node.item.path;
    cfg.orderedPaths = list;
    this.saveConfigForWork(activeWork.path, cfg);
    await this.reloadVaultAndRebuild();
  }

  private async toggleNodeIncluded(node: HierarchyNode) {
    const activeWork = this.getActiveWork();
    if (!activeWork) return;

    const cfg = this.getConfigForWork(activeWork.path);
    const set = new Set(cfg.excludedPaths);
    if (set.has(node.item.path)) {
      set.delete(node.item.path);
    } else {
      set.add(node.item.path);
    }
    cfg.excludedPaths = [...set];
    this.saveConfigForWork(activeWork.path, cfg);
    await this.reloadVaultAndRebuild();
  }

  private async handleCompileAndOpenFile() {
    const activeWork = this.getActiveWork();
    if (!activeWork || !this.compiled) return;

    try {
      const file = await writeCompiledFileToVault(
        this.app,
        this.compiled.outputFilePath,
        this.compiled.markdown
      );
      new Notice(`✓ Собрано: «${file.path}»`);
      this.safeClose();
      await this.app.workspace.openLinkText(file.path, "", true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice("Ошибка сохранения сборки: " + msg);
    }
  }

  private async handleCopyMarkdown() {
    if (!this.compiled) return;
    try {
      await navigator.clipboard.writeText(this.compiled.markdown);
      new Notice("📋 Текст рукописи скопирован в буфер обмена");
    } catch {
      new Notice("Не удалось скопировать в буфер обмена");
    }
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();

    // 1. Шапка окна
    const headBar = contentEl.createDiv("my-sc-head-bar");
    const titleWrap = headBar.createDiv("my-sc-head-title");
    titleWrap.createSpan({ text: "🎓 Конструктор научных работ и проектов" });

    const closeBtn = headBar.createEl("button", {
      cls: "my-sc-close-btn",
      text: "✕",
      attr: {
        type: "button",
        title: "Закрыть (Esc)",
        "aria-label": "Закрыть конструктор",
      },
    });
    closeBtn.onclick = () => this.safeClose();

    const activeWork = this.getActiveWork();
    if (!activeWork) {
      const emptyBox = contentEl.createDiv("my-sc-empty");
      emptyBox.setText(
        "В хранилище не найдено активных учебных проектов (направление: «Учёба»)."
      );
      return;
    }

    const workMeta = getWorkMeta(activeWork.noteType, activeWork.customIcon);
    const cfg = this.getConfigForWork(activeWork.path);
    const audit = this.compiled?.audit;

    // 2. Панель выбора проекта и быстрых показателей
    const projectBar = contentEl.createDiv("my-sc-project-bar");
    const selectWrap = projectBar.createDiv("my-sc-project-select-wrap");

    const workSel = selectWrap.createEl("select", {
      cls: "dropdown my-sc-work-select",
      attr: { title: "Выбор учебного проекта или работы" },
    });
    for (const w of this.works) {
      const meta = getWorkMeta(w.noteType, w.customIcon);
      const statusSuffix = !w.isActiveWork ? " [завершён]" : "";
      const o = workSel.createEl("option", {
        text: `${meta.icon} ${w.name} (${w.noteType})${statusSuffix}`,
        value: w.path,
      });
      if (w.path === activeWork.path) o.selected = true;
    }
    workSel.onchange = () => {
      this.selectedWorkPath = workSel.value;
      void this.reloadVaultAndRebuild();
    };

    const showDoneBtn = selectWrap.createEl("button", {
      cls:
        "my-sc-chip-btn" +
        (this.plugin.settings.showCompletedWorks ? " is-active" : ""),
      text: this.plugin.settings.showCompletedWorks
        ? "✓ Все проекты"
        : "В работе",
      attr: {
        type: "button",
        title: "Показывать также завершённые проекты",
      },
    });
    showDoneBtn.onclick = () => {
      this.plugin.settings.showCompletedWorks =
        !this.plugin.settings.showCompletedWorks;
      this.plugin.requestSaveSettings();
      void this.reloadVaultAndRebuild();
    };

    const openWorkBtn = selectWrap.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "📄 Открыть корень",
      attr: { type: "button", title: "Открыть корневую заметку проекта" },
    });
    openWorkBtn.onclick = () => {
      this.safeClose();
      void this.app.workspace.openLinkText(activeWork.path, "", false);
    };

    // Сводные плашки объёма
    if (audit) {
      const kpiRow = contentEl.createDiv("my-sc-kpi-row");
      const kpis = [
        {
          label: "Разделов",
          val: `${audit.includedNodes} / ${audit.totalNodes}`,
          color: workMeta.color,
        },
        {
          label: "Слов / стр.",
          val: `${audit.totalWords.toLocaleString("ru-RU")} (~${audit.approxPages} стр.)`,
          color: "#599ed6",
        },
        {
          label: "Авт. листов",
          val: `${audit.authorSheets} а.л.`,
          color: "#9c83e8",
        },
        {
          label: "Источники",
          val: `${audit.sourcesCited.length} / ${audit.sourcesTotal.length} процит.`,
          color:
            audit.sourcesUncited.length > 0 ? "#e5a158" : "#4aab80",
        },
      ];
      for (const k of kpis) {
        const box = kpiRow.createDiv("my-sc-kpi-card");
        box.style.setProperty("--kpi-color", k.color);
        box.createSpan({ cls: "my-sc-kpi-label", text: k.label });
        box.createSpan({ cls: "my-sc-kpi-val", text: k.val });
      }
    }

    // 3. Вкладки: Структура | Аудит | Предпросмотр
    const tabsRow = contentEl.createDiv("my-sc-tabs-row");
    const uncitedCount =
      (audit?.sourcesUncited.length ?? 0) +
      (audit?.visualsUnreferenced.length ?? 0);
    const tabs: Array<{ id: CompilerTab; label: string }> = [
      {
        id: "structure",
        label: `📐 Структура (${this.nodes.length})`,
      },
      {
        id: "audit",
        label:
          uncitedCount > 0
            ? `🔍 Аудит и источники (⚠️ ${uncitedCount})`
            : "🔍 Аудит и источники (✓)",
      },
      {
        id: "preview",
        label: "📄 Настройки и предпросмотр",
      },
    ];

    for (const t of tabs) {
      const b = tabsRow.createEl("button", {
        cls: "my-sc-tab-btn" + (this.activeTab === t.id ? " is-active" : ""),
        text: t.label,
        attr: { type: "button" },
      });
      b.onclick = () => {
        this.activeTab = t.id;
        this.render();
      };
    }

    // 4. Тело активной вкладки
    const bodyEl = contentEl.createDiv("my-sc-body");

    if (this.activeTab === "structure") {
      this.renderStructureTab(bodyEl, activeWork, cfg);
    } else if (this.activeTab === "audit") {
      this.renderAuditTab(bodyEl, activeWork);
    } else {
      this.renderPreviewTab(bodyEl, activeWork, cfg);
    }

    // 5. Нижняя панель действий
    const footerEl = contentEl.createDiv("my-sc-footer");
    const outHint = footerEl.createDiv("my-sc-footer-path");
    outHint.setText(
      `Файл сборки: ${this.compiled?.outputFilePath ?? "Знания/Сборки/..."}`
    );

    const actionsWrap = footerEl.createDiv("my-sc-footer-actions");
    const copyBtn = actionsWrap.createEl("button", {
      cls: "my-sc-chip-btn",
      text: "📋 Скопировать текст",
      attr: { type: "button" },
    });
    copyBtn.onclick = () => void this.handleCopyMarkdown();

    const compileBtn = actionsWrap.createEl("button", {
      cls: "mod-cta my-sc-primary-btn",
      text: "📄 Собрать и открыть рукопись",
      attr: { type: "button" },
    });
    compileBtn.onclick = () => void this.handleCompileAndOpenFile();
  }

  private renderStructureTab(
    parent: HTMLElement,
    activeWork: StudyNoteItem,
    cfg: ProjectCompileConfig
  ) {
    const topBar = parent.createDiv("my-sc-struct-topbar");

    const rootChkLabel = topBar.createEl("label", {
      cls: "my-sc-check-label",
    });
    const rootChk = rootChkLabel.createEl("input", {
      attr: { type: "checkbox" },
    });
    rootChk.checked = cfg.includeRootBody;
    rootChkLabel.createSpan({
      text: `Включать вступление из корневой заметки (${this.rootWords} сл.)`,
    });
    rootChk.onchange = () => {
      cfg.includeRootBody = rootChk.checked;
      this.saveConfigForWork(activeWork.path, cfg);
      void this.reloadVaultAndRebuild();
    };

    const rightBtns = topBar.createDiv("my-sc-struct-btns");
    const addSecBtn = rightBtns.createEl("button", {
      cls: "my-sc-chip-btn" + (this.isAddingSectionOpen ? " is-active" : ""),
      text: this.isAddingSectionOpen ? "✕ Отмена" : "+ Новый раздел",
      attr: { type: "button" },
    });
    addSecBtn.onclick = () => {
      this.isAddingSectionOpen = !this.isAddingSectionOpen;
      if (!this.newSectionParentPath) {
        this.newSectionParentPath = activeWork.path;
      }
      this.render();
    };

    if (this.isAddingSectionOpen) {
      const formBox = parent.createDiv("my-sc-add-box");
      const typeSel = formBox.createEl("select", { cls: "dropdown" });
      for (const mt of MATERIAL_TYPES) {
        const o = typeSel.createEl("option", { text: mt, value: mt });
        if (mt === this.newSectionType) o.selected = true;
      }
      typeSel.onchange = () => {
        this.newSectionType = typeSel.value;
      };

      const titleInp = formBox.createEl("input", {
        cls: "my-sc-input",
        attr: {
          type: "text",
          placeholder: "Название нового раздела или материала…",
          value: this.newSectionTitle,
        },
      });
      titleInp.oninput = () => {
        this.newSectionTitle = titleInp.value;
      };

      const parentSel = formBox.createEl("select", { cls: "dropdown" });
      parentSel.createEl("option", {
        text: `↳ В корень: ${activeWork.name}`,
        value: activeWork.path,
      });
      for (const n of this.nodes) {
        const indent = "  ".repeat(n.depth + 1);
        const o = parentSel.createEl("option", {
          text: `${indent}↳ Внутрь: ${n.item.name}`,
          value: n.item.path,
        });
        if (this.newSectionParentPath === n.item.path) o.selected = true;
      }
      parentSel.onchange = () => {
        this.newSectionParentPath = parentSel.value;
      };

      const createBtn = formBox.createEl("button", {
        cls: "mod-cta my-sc-action-btn",
        text: "Создать",
        attr: { type: "button" },
      });

      const doCreate = async () => {
        const cleanTitle = this.newSectionTitle
          .trim()
          .replace(/[\\/:*?"<>|]/g, "");
        if (!cleanTitle) {
          new Notice("Введи название заметки.");
          return;
        }
        const targetPath = normalizePath(`Знания/${cleanTitle}.md`);
        if (this.app.vault.getAbstractFileByPath(targetPath)) {
          new Notice("Заметка с таким именем уже существует в папке Знания.");
          return;
        }
        const parentItem =
          this.byPath.get(this.newSectionParentPath) ?? activeWork;
        createBtn.disabled = true;
        try {
          await ensureVaultFolderExists(this.app, "Знания");
          const discLine = activeWork.discipline
            ? `дисциплина: ${JSON.stringify(activeWork.discipline)}\n`
            : "";
          const content =
            `---\n` +
            `направление: "${this.plugin.settings.studyAreaName}"\n` +
            `тип: ${JSON.stringify(this.newSectionType)}\n` +
            `родитель: "[[${parentItem.name}]]"\n` +
            discLine +
            `---\n\n# ${cleanTitle}\n\n`;
          await this.app.vault.create(targetPath, content);
          this.newSectionTitle = "";
          this.isAddingSectionOpen = false;
          new Notice(`Создан раздел «${cleanTitle}»`);
          setTimeout(() => void this.reloadVaultAndRebuild(), 120);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice("Ошибка создания: " + msg);
          createBtn.disabled = false;
        }
      };
      createBtn.onclick = () => void doCreate();
    }

    if (this.nodes.length === 0) {
      parent.createDiv({
        cls: "my-sc-empty",
        text: "К этому проекту ещё не привязано ни одной заметки через свойство «родитель».",
      });
      return;
    }

    const listEl = parent.createDiv("my-sc-tree-list");

    for (const node of this.nodes) {
      const row = listEl.createDiv(
        "my-sc-tree-row" + (!node.included ? " is-excluded" : "")
      );
      row.style.paddingLeft = `${10 + node.depth * 20}px`;

      const left = row.createDiv("my-sc-tree-left");

      const chk = left.createEl("input", {
        attr: {
          type: "checkbox",
          title: "Включить или исключить из сборки",
        },
      });
      chk.checked = node.included;
      chk.onchange = () => void this.toggleNodeIncluded(node);

      if (node.sectionNumber !== "—") {
        left.createSpan({
          cls: "my-sc-sec-num",
          text: node.sectionNumber,
        });
      }

      const titleLink = left.createSpan({
        cls: "my-sc-node-title",
        text: node.item.name,
        attr: { title: "Открыть заметку" },
      });
      titleLink.onclick = () => {
        this.safeClose();
        void this.app.workspace.openLinkText(node.item.path, "", false);
      };

      const tColor = TYPE_COLORS[node.item.noteType] ?? "#8a8f98";
      const badge = left.createSpan({
        cls: "my-sc-type-badge",
        text: node.item.noteType,
      });
      badge.style.setProperty("--badge-color", tColor);

      const right = row.createDiv("my-sc-tree-right");
      right.createSpan({
        cls: "my-sc-word-count",
        text: `${node.wordCount} сл.`,
      });

      const siblings = this.nodes.filter(
        (n) => n.parentPath === node.parentPath && n.depth === node.depth
      );
      const sibIdx = siblings.findIndex(
        (s) => s.item.path === node.item.path
      );

      const upBtn = right.createEl("button", {
        cls: "my-sc-move-btn",
        text: "▲",
        attr: { type: "button", title: "Переместить выше" },
      });
      upBtn.disabled = sibIdx <= 0;
      upBtn.onclick = () => void this.moveNodeInSiblingGroup(node, -1);

      const downBtn = right.createEl("button", {
        cls: "my-sc-move-btn",
        text: "▼",
        attr: { type: "button", title: "Переместить ниже" },
      });
      downBtn.disabled = sibIdx === -1 || sibIdx >= siblings.length - 1;
      downBtn.onclick = () => void this.moveNodeInSiblingGroup(node, 1);
    }
  }

  private renderAuditTab(parent: HTMLElement, _activeWork: StudyNoteItem) {
    const audit = this.compiled?.audit;
    if (!audit) return;

    const grid = parent.createDiv("my-sc-audit-grid");

    // 1. Сводка объёма и элементов
    const statsBox = grid.createDiv("my-sc-audit-box");
    statsBox.createDiv({
      cls: "my-sc-audit-title",
      text: "📊 Метрики рукописи",
    });
    const rows: Array<[string, string]> = [
      ["Печатных знаков (с пробелами)", audit.totalCharsWithSpaces.toLocaleString("ru-RU")],
      ["Авторских листов (40 000 зн.)", `${audit.authorSheets} а.л.`],
      ["Расчётных страниц (~1800 зн.)", `${audit.approxPages} стр.`],
      ["Слов в чистовом тексте", audit.totalWords.toLocaleString("ru-RU")],
      ["Математических формул", String(audit.totalFormulas)],
      ["Таблиц / Иллюстраций", `${audit.totalTables} табл. · ${audit.totalFigures} рис.`],
    ];
    for (const [k, v] of rows) {
      const r = statsBox.createDiv("my-sc-audit-row");
      r.createSpan({ cls: "my-sc-audit-k", text: k });
      r.createSpan({ cls: "my-sc-audit-v", text: v });
    }

    // 2. Контроль цитирования источников
    const srcBox = grid.createDiv("my-sc-audit-box");
    srcBox.createDiv({
      cls: "my-sc-audit-title",
      text: `📚 Цитирование источников (${audit.sourcesCited.length} из ${audit.sourcesTotal.length})`,
    });

    if (audit.sourcesTotal.length === 0) {
      srcBox.createDiv({
        cls: "my-sc-audit-hint",
        text: "В проекте пока нет заметок с типом «Источник».",
      });
    } else if (audit.sourcesUncited.length === 0) {
      srcBox.createDiv({
        cls: "my-sc-audit-ok",
        text: "✓ Все привязанные источники упомянуты в тексте разделов [[...]].",
      });
    } else {
      srcBox.createDiv({
        cls: "my-sc-audit-warn",
        text: `⚠️ Не упомянуты в тексте (${audit.sourcesUncited.length}):`,
      });
      for (const s of audit.sourcesUncited) {
        const item = srcBox.createDiv("my-sc-audit-link");
        item.setText(`• [[${s.name}]]`);
        item.onclick = () => {
          this.safeClose();
          void this.app.workspace.openLinkText(s.path, "", false);
        };
      }
    }

    // 3. Неиспользованные рисунки / таблицы и пустые разделы
    if (
      audit.visualsUnreferenced.length > 0 ||
      audit.emptySectionNotes.length > 0
    ) {
      const warnBox = parent.createDiv("my-sc-audit-box");
      warnBox.createDiv({
        cls: "my-sc-audit-title",
        text: "⚠️ Замечания по структуре",
      });

      if (audit.visualsUnreferenced.length > 0) {
        warnBox.createDiv({
          cls: "my-sc-audit-warn",
          text: `Не вставлены ссылки на рисунки/таблицы (${audit.visualsUnreferenced.length}):`,
        });
        for (const v of audit.visualsUnreferenced) {
          const item = warnBox.createDiv("my-sc-audit-link");
          item.setText(`• ${v.noteType}: [[${v.name}]]`);
          item.onclick = () => {
            this.safeClose();
            void this.app.workspace.openLinkText(v.path, "", false);
          };
        }
      }

      if (audit.emptySectionNotes.length > 0) {
        warnBox.createDiv({
          cls: "my-sc-audit-warn",
          text: `Почти пустые разделы (< 5 слов):`,
        });
        for (const e of audit.emptySectionNotes) {
          const item = warnBox.createDiv("my-sc-audit-link");
          item.setText(`• ${e.name} (${e.noteType})`);
          item.onclick = () => {
            this.safeClose();
            void this.app.workspace.openLinkText(e.path, "", false);
          };
        }
      }
    }
  }

  private renderPreviewTab(
    parent: HTMLElement,
    activeWork: StudyNoteItem,
    cfg: ProjectCompileConfig
  ) {
    const optsGrid = parent.createDiv("my-sc-opts-grid");

    const toggles: Array<{
      key: keyof Pick<
        ProjectCompileConfig,
        | "numberSections"
        | "stripLeadingH1"
        | "groupTermsIntoGlossary"
        | "buildBibliography"
        | "replaceSourceLinksWithNumbers"
        | "autoNumberFiguresAndTables"
      >;
      label: string;
    }> = [
      {
        key: "numberSections",
        label: "Нумеровать заголовки разделов (1., 1.1., 1.2.)",
      },
      {
        key: "stripLeadingH1",
        label: "Убирать дублирующий верхний # Заголовок внутри заметок",
      },
      {
        key: "groupTermsIntoGlossary",
        label: "Собирать заметки «Термин» в раздел «Термины и определения»",
      },
      {
        key: "buildBibliography",
        label: "Формировать «Список использованных источников» в конце",
      },
      {
        key: "replaceSourceLinksWithNumbers",
        label: "Заменять [[Ссылки на источники]] в тексте на сноски [1], [2]",
      },
      {
        key: "autoNumberFiguresAndTables",
        label: "Автонумерация заголовков «Рисунок N» и «Таблица N»",
      },
    ];

    for (const tg of toggles) {
      const lbl = optsGrid.createEl("label", { cls: "my-sc-check-label" });
      const inp = lbl.createEl("input", { attr: { type: "checkbox" } });
      inp.checked = cfg[tg.key];
      lbl.createSpan({ text: tg.label });
      inp.onchange = () => {
        cfg[tg.key] = inp.checked;
        this.saveConfigForWork(activeWork.path, cfg);
        void this.reloadVaultAndRebuild();
      };
    }

    const previewArea = parent.createEl("textarea", {
      cls: "my-sc-preview-textarea",
      attr: { readonly: "true", rows: "14" },
    });
    previewArea.value = this.compiled?.markdown ?? "";
  }
}