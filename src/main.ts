// C:\Users\user\dev\my-study-compiler\src\main.ts
import { App, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  Point,
  ProjectGroupTab,
  StudyCompilerSettings,
} from "./types";
import { OpenOptions, StudyCompilerModal } from "./modal";
import { syncAutoAdoptedFrontmatter } from "./scanner";

function migrateSettings(raw: unknown): StudyCompilerSettings {
  const s =
    raw && typeof raw === "object"
      ? (raw as Partial<StudyCompilerSettings> & { showCompletedWorks?: boolean })
      : {};
  const strList = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [...fallback];

  const focusedBranchByWork: Record<string, string> = {};
  if (s.focusedBranchByWork && typeof s.focusedBranchByWork === "object") {
    for (const [k, v] of Object.entries(s.focusedBranchByWork as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) focusedBranchByWork[k] = v;
    }
  }

  const graphNodePositions: Record<string, Record<string, Point>> = {};
  if (
    s.graphNodePositions &&
    typeof s.graphNodePositions === "object" &&
    !Array.isArray(s.graphNodePositions)
  ) {
    for (const [graphKey, nodesMap] of Object.entries(
      s.graphNodePositions as Record<string, unknown>
    )) {
      if (!graphKey || !nodesMap || typeof nodesMap !== "object" || Array.isArray(nodesMap)) {
        continue;
      }
      const cleanMap: Record<string, Point> = {};
      for (const [nodePath, pos] of Object.entries(nodesMap as Record<string, unknown>)) {
        if (!nodePath || !pos || typeof pos !== "object") continue;
        const p = pos as { x?: unknown; y?: unknown };
        if (
          typeof p.x === "number" &&
          Number.isFinite(p.x) &&
          typeof p.y === "number" &&
          Number.isFinite(p.y)
        ) {
          cleanMap[nodePath] = { x: Math.round(p.x), y: Math.round(p.y) };
        }
      }
      if (Object.keys(cleanMap).length > 0) {
        graphNodePositions[graphKey] = cleanMap;
      }
    }
  }

  let projectGroupTab: ProjectGroupTab = "active";
  if (s.projectGroupTab === "active" || s.projectGroupTab === "completed") {
    projectGroupTab = s.projectGroupTab;
  }

  return {
    studyAreaName:
      typeof s.studyAreaName === "string" && s.studyAreaName.trim()
        ? s.studyAreaName.trim()
        : DEFAULT_SETTINGS.studyAreaName,
    newNoteFolder:
      typeof s.newNoteFolder === "string" && s.newNoteFolder.trim()
        ? s.newNoteFolder.trim()
        : DEFAULT_SETTINGS.newNoteFolder,
    mediaFolder:
      typeof s.mediaFolder === "string" && s.mediaFolder.trim()
        ? s.mediaFolder.trim()
        : DEFAULT_SETTINGS.mediaFolder,
    projectGroupTab,
    lastUsedMaterialType:
      typeof s.lastUsedMaterialType === "string" && s.lastUsedMaterialType.trim()
        ? s.lastUsedMaterialType.trim()
        : DEFAULT_SETTINGS.lastUsedMaterialType,
    autoInheritFromLinks:
      typeof s.autoInheritFromLinks === "boolean"
        ? s.autoInheritFromLinks
        : DEFAULT_SETTINGS.autoInheritFromLinks,
    defaultAutoNoteType:
      typeof s.defaultAutoNoteType === "string" && s.defaultAutoNoteType.trim()
        ? s.defaultAutoNoteType.trim()
        : DEFAULT_SETTINGS.defaultAutoNoteType,
    excludedFolders: strList(s.excludedFolders, DEFAULT_SETTINGS.excludedFolders),
    excludedTitlePrefixes: strList(
      s.excludedTitlePrefixes,
      DEFAULT_SETTINGS.excludedTitlePrefixes
    ),
    excludedTags: strList(s.excludedTags, DEFAULT_SETTINGS.excludedTags),
    expandedPaths: strList(s.expandedPaths, []),
    lastWorkPath: typeof s.lastWorkPath === "string" ? s.lastWorkPath : "",
    focusedBranchByWork,
    graphNodePositions,
  };
}

class StudyCompilerSettingTab extends PluginSettingTab {
  plugin: MyStudyCompilerPlugin;

  constructor(app: App, plugin: MyStudyCompilerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Конструктор учебных проектов" });

    new Setting(containerEl)
      .setName("Автонаследование иерархии по вики-ссылкам из текста и схем")
      .setDesc(
        "Если внутри проекта, конспекта или на графической схеме поставлена ссылка [[Термин Б]], плагин автоматически выстраивает цепочку родителей и прописывает «направление» и «родитель» в YAML"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoInheritFromLinks)
          .onChange((val) => {
            this.plugin.settings.autoInheritFromLinks = val;
            this.plugin.requestSaveSettings();
            if (val) {
              this.plugin.scheduleAutoInheritSync();
            }
          })
      );

    new Setting(containerEl)
      .setName("Тип по умолчанию для заметок из вики-ссылок")
      .setDesc(
        "Записывается в свойство «тип», если у новой заметки тип ещё не указан (по умолчанию: Заметка)"
      )
      .addText((text) =>
        text
          .setPlaceholder("Заметка")
          .setValue(this.plugin.settings.defaultAutoNoteType)
          .onChange((val) => {
            this.plugin.settings.defaultAutoNoteType =
              val.trim() || DEFAULT_SETTINGS.defaultAutoNoteType;
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Синхронизировать YAML по ссылкам сейчас")
      .setDesc(
        "Проверить все ветки учебных проектов и прописать «родитель» и «направление» тем заметкам, на которые ведут ссылки из конспектов и схем"
      )
      .addButton((btn) =>
        btn.setButtonText("Синхронизировать").onClick(async () => {
          btn.setDisabled(true);
          const count = await syncAutoAdoptedFrontmatter(
            this.app,
            this.plugin.settings
          );
          new Notice(
            count > 0
              ? `Обновлено заметок по ссылкам: ${count}`
              : "Все связанные заметки уже синхронизированы."
          );
          btn.setDisabled(false);
        })
      );

    new Setting(containerEl)
      .setName("Направление в YAML")
      .setDesc("Значение свойства «направление». По умолчанию: Учёба")
      .addText((text) =>
        text.setValue(this.plugin.settings.studyAreaName).onChange((val) => {
          this.plugin.settings.studyAreaName =
            val.trim() || DEFAULT_SETTINGS.studyAreaName;
          this.plugin.requestSaveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Папка для новых заметок")
      .setDesc("По умолчанию: Знания")
      .addText((text) =>
        text.setValue(this.plugin.settings.newNoteFolder).onChange((val) => {
          this.plugin.settings.newNoteFolder =
            val.trim() || DEFAULT_SETTINGS.newNoteFolder;
          this.plugin.requestSaveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Папка для сохраняемых картинок и схем")
      .setDesc("Куда сохранять изображения при вставке из буфера обмена (по умолчанию: Знания/Вложения)")
      .addText((text) =>
        text.setValue(this.plugin.settings.mediaFolder).onChange((val) => {
          this.plugin.settings.mediaFolder =
            val.trim() || DEFAULT_SETTINGS.mediaFolder;
          this.plugin.requestSaveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Игнорируемые папки")
      .setDesc("Через запятую. Заметки и шаблоны внутри этих папок не попадают в список")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.excludedFolders.join(", "))
          .onChange((val) => {
            this.plugin.settings.excludedFolders = val
              .split(",")
              .map((x) => x.trim())
              .filter((x) => x.length > 0);
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Игнорируемые префиксы имён файлов (шаблоны)")
      .setDesc("Через запятую. Например: «Учёба — , Шаблон, Template»")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.excludedTitlePrefixes.join(", "))
          .onChange((val) => {
            this.plugin.settings.excludedTitlePrefixes = val
              .split(",")
              .map((x) => x.trim())
              .filter((x) => x.length > 0);
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Игнорируемые теги")
      .setDesc("Через запятую без решётки (по умолчанию: шаблон, template)")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.excludedTags.join(", "))
          .onChange((val) => {
            this.plugin.settings.excludedTags = val
              .split(",")
              .map((x) => x.trim().replace(/^#/, ""))
              .filter((x) => x.length > 0);
            this.plugin.requestSaveSettings();
          })
      );
  }
}

export default class MyStudyCompilerPlugin extends Plugin {
  settings!: StudyCompilerSettings;
  private saveTimer: number | null = null;
  private autoSyncTimer: number | null = null;
  private isSyncingAutoYaml = false;

  async onload() {
    this.settings = migrateSettings(await this.loadData());
    this.addSettingTab(new StudyCompilerSettingTab(this.app, this));

    this.addRibbonIcon("folder-tree", "Открыть проекты и подпроекты", () => {
      this.openCompiler();
    });

    this.registerObsidianProtocolHandler("my-compiler", (params) => {
      this.openCompiler({
        rootPath: params.project || undefined,
        addUnder: params.parent || undefined,
      });
    });

    this.addCommand({
      id: "open-study-compiler",
      name: "Открыть проекты и подпроекты",
      callback: () => this.openCompiler(),
    });

    this.addCommand({
      id: "new-subproject-here",
      name: "Новый подпроект в текущей заметке",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.openCompiler({ addUnder: file.path });
        return true;
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.scheduleAutoInheritSync(800);

      this.registerEvent(
        this.app.metadataCache.on("changed", () => {
          this.scheduleAutoInheritSync(1200);
        })
      );
      this.registerEvent(
        this.app.vault.on("create", () => {
          this.scheduleAutoInheritSync(1000);
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
          this.handlePathRename(oldPath, file.path);
        })
      );
    });
  }

  private handlePathRename(oldPath: string, newPath: string): void {
    let changed = false;

    if (this.settings.lastWorkPath === oldPath) {
      this.settings.lastWorkPath = newPath;
      changed = true;
    }

    const expIdx = this.settings.expandedPaths.indexOf(oldPath);
    if (expIdx !== -1) {
      this.settings.expandedPaths[expIdx] = newPath;
      changed = true;
    }

    if (this.settings.focusedBranchByWork[oldPath] !== undefined) {
      this.settings.focusedBranchByWork[newPath] =
        this.settings.focusedBranchByWork[oldPath]!;
      delete this.settings.focusedBranchByWork[oldPath];
      changed = true;
    }
    for (const [k, v] of Object.entries(this.settings.focusedBranchByWork)) {
      if (v === oldPath) {
        this.settings.focusedBranchByWork[k] = newPath;
        changed = true;
      }
    }

    if (this.settings.graphNodePositions[oldPath] !== undefined) {
      this.settings.graphNodePositions[newPath] =
        this.settings.graphNodePositions[oldPath]!;
      delete this.settings.graphNodePositions[oldPath];
      changed = true;
    }
    for (const map of Object.values(this.settings.graphNodePositions)) {
      if (map && map[oldPath] !== undefined) {
        map[newPath] = map[oldPath]!;
        delete map[oldPath];
        changed = true;
      }
    }

    if (changed) {
      this.requestSaveSettings();
    }
  }

  scheduleAutoInheritSync(delayMs = 1000): void {
    if (!this.settings.autoInheritFromLinks || this.isSyncingAutoYaml) return;
    if (this.autoSyncTimer !== null) {
      window.clearTimeout(this.autoSyncTimer);
    }
    this.autoSyncTimer = window.setTimeout(async () => {
      this.autoSyncTimer = null;
      if (this.isSyncingAutoYaml) return;
      this.isSyncingAutoYaml = true;
      try {
        await syncAutoAdoptedFrontmatter(this.app, this.settings);
      } finally {
        this.isSyncingAutoYaml = false;
      }
    }, delayMs);
  }

  openCompiler(options: OpenOptions = {}) {
    new StudyCompilerModal(this.app, this, options).open();
  }

  requestSaveSettings() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveData(this.settings);
    }, 300);
  }

  onunload() {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.autoSyncTimer !== null) {
      window.clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }
}