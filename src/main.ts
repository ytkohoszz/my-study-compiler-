import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS, StudyCompilerSettings } from "./types";
import { OpenOptions, StudyCompilerModal } from "./modal";

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
      .setDesc(
        "Через запятую. Например: «Учёба — , Шаблон, Template» — скрывает заметки-шаблоны из выпадающего списка проектов"
      )
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