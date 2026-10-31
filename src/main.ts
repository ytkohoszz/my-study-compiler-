import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  KEYS,
  NEW_NOTE_TYPES,
  StudyCompilerSettings,
} from "./types";
import { OpenOptions, StudyCompilerModal } from "./modal";
import {
  findRootPath,
  flattenFrontmatterValue,
  scanStudyVault,
} from "./scanner";

function migrateSettings(raw: unknown): StudyCompilerSettings {
  const s = raw && typeof raw === "object" ? (raw as Partial<StudyCompilerSettings>) : {};
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

  return {
    studyAreaName:
      typeof s.studyAreaName === "string" && s.studyAreaName.trim()
        ? s.studyAreaName.trim()
        : DEFAULT_SETTINGS.studyAreaName,
    newNoteFolder:
      typeof s.newNoteFolder === "string" && s.newNoteFolder.trim()
        ? s.newNoteFolder.trim()
        : DEFAULT_SETTINGS.newNoteFolder,
    defaultLinkNoteType:
      typeof s.defaultLinkNoteType === "string" && s.defaultLinkNoteType.trim()
        ? s.defaultLinkNoteType.trim()
        : DEFAULT_SETTINGS.defaultLinkNoteType,
    autoLinkNewNotesFromProject:
      typeof s.autoLinkNewNotesFromProject === "boolean"
        ? s.autoLinkNewNotesFromProject
        : DEFAULT_SETTINGS.autoLinkNewNotesFromProject,
    excludedFolders: strList(s.excludedFolders, DEFAULT_SETTINGS.excludedFolders),
    excludedTitlePrefixes: strList(
      s.excludedTitlePrefixes,
      DEFAULT_SETTINGS.excludedTitlePrefixes
    ),
    excludedTags: strList(s.excludedTags, DEFAULT_SETTINGS.excludedTags),
    expandedPaths: strList(s.expandedPaths, []),
    lastWorkPath: typeof s.lastWorkPath === "string" ? s.lastWorkPath : "",
    focusedBranchByWork,
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
      .setName("Тип по умолчанию для привязанных [[ссылок]]")
      .setDesc("Какой тип подставлять при добавлении ссылок из текста в проект")
      .addDropdown((drop) => {
        for (const t of NEW_NOTE_TYPES) {
          drop.addOption(t, t);
        }
        drop.setValue(this.plugin.settings.defaultLinkNoteType || "Термин");
        drop.onChange((val) => {
          this.plugin.settings.defaultLinkNoteType = val;
          this.plugin.requestSaveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Автопривязка при клике по новой [[ссылке]] из заметки проекта")
      .setDesc(
        "Если включено: когда ты кликаешь по ещё не существующей [[ссылке]] внутри заметки учебного проекта и Obsidian создаёт пустой файл, плагин автоматически пропишет ему направление «Учёба», тип и родителя"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoLinkNewNotesFromProject)
          .onChange((val) => {
            this.plugin.settings.autoLinkNewNotesFromProject = val;
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
  private lastActiveStudyFile: TFile | null = null;

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
      this.trackActiveStudyFile(this.app.workspace.getActiveFile());

      this.registerEvent(
        this.app.workspace.on("file-open", (file) => {
          this.trackActiveStudyFile(file);
        })
      );

      this.registerEvent(
        this.app.vault.on("create", (abstractFile) => {
          if (
            this.settings.autoLinkNewNotesFromProject &&
            abstractFile instanceof TFile &&
            abstractFile.extension.toLowerCase() === "md"
          ) {
            void this.tryAutoLinkCreatedNote(abstractFile);
          }
        })
      );
    });
  }

  private trackActiveStudyFile(file: TFile | null) {
    if (!file || file.extension.toLowerCase() !== "md") return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (
      fm &&
      flattenFrontmatterValue(fm[KEYS.area]).includes(this.settings.studyAreaName)
    ) {
      this.lastActiveStudyFile = file;
    }
  }

  private async tryAutoLinkCreatedNote(newFile: TFile) {
    const parentFile = this.lastActiveStudyFile;
    if (!parentFile || parentFile.path === newFile.path) return;

    // Небольшая пауза, чтобы Obsidian успел записать ссылку и базовое содержимое
    await new Promise((r) => window.setTimeout(r, 180));

    const parentCache = this.app.metadataCache.getFileCache(parentFile);
    const linksInParent = parentCache?.links ?? [];
    const isLinkedFromParent = linksInParent.some((l) => {
      const dest = this.app.metadataCache.getFirstLinkpathDest(
        l.link.split("#")[0]?.split("|")[0]?.trim() || "",
        parentFile.path
      );
      return dest?.path === newFile.path || l.link.includes(newFile.basename);
    });

    if (!isLinkedFromParent) return;

    const newCache = this.app.metadataCache.getFileCache(newFile);
    if (newCache?.frontmatter && newCache.frontmatter[KEYS.parent]) return;

    const scan = scanStudyVault(this.app, this.settings);
    const rootPath = findRootPath(scan, parentFile.path);
    const rootItem = scan.byPath.get(rootPath);

    const parentLink = `[[${this.app.metadataCache.fileToLinktext(
      parentFile,
      newFile.path
    )}]]`;
    const defaultType = this.settings.defaultLinkNoteType || "Термин";

    try {
      await this.app.fileManager.processFrontMatter(
        newFile,
        (fm: Record<string, unknown>) => {
          if (!fm[KEYS.area]) fm[KEYS.area] = this.settings.studyAreaName;
          if (!fm[KEYS.type]) fm[KEYS.type] = defaultType;
          if (!fm[KEYS.parent]) fm[KEYS.parent] = parentLink;
          if (rootItem?.discipline && !fm[KEYS.discipline]) {
            fm[KEYS.discipline] = rootItem.discipline;
          }
        }
      );
      new Notice(`🔗 Автопривязка к «${parentFile.basename}»: ${newFile.basename}`);
    } catch {
      // игнорируем
    }
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
  }
}