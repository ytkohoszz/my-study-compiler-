import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import {
  DEFAULT_SETTINGS,
  StudyCompilerSettings,
} from "./types";
import { StudyCompilerModal } from "./modal";

function migrateSettings(raw: unknown): StudyCompilerSettings {
  const source =
    raw && typeof raw === "object"
      ? (raw as Partial<StudyCompilerSettings>)
      : {};
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    projectConfigs:
      source.projectConfigs && typeof source.projectConfigs === "object"
        ? source.projectConfigs
        : {},
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

    containerEl.createEl("h3", {
      text: "Конструктор и сборщик научных работ",
    });

    new Setting(containerEl)
      .setName("Папка для сохранения сборок")
      .setDesc("По умолчанию: Знания/Сборки")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.outputFolder)
          .onChange((val) => {
            this.plugin.settings.outputFolder =
              val.trim() || "Знания/Сборки";
            this.plugin.requestSaveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Название направления учёбы в YAML")
      .setDesc("По умолчанию: Учёба")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.studyAreaName)
          .onChange((val) => {
            this.plugin.settings.studyAreaName = val.trim() || "Учёба";
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

    this.addRibbonIcon(
      "book-open-check",
      "Открыть конструктор научных работ",
      () => {
        this.openCompiler();
      }
    );

    this.registerObsidianProtocolHandler("my-compiler", (params) => {
      this.openCompiler(params.project || undefined);
    });

    this.addCommand({
      id: "open-study-compiler",
      name: "Открыть конструктор и сборщик учебных работ",
      callback: () => {
        this.openCompiler();
      },
    });
  }

  openCompiler(projectPath?: string) {
    new StudyCompilerModal(this.app, this, projectPath).open();
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