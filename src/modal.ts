// C:\Users\user\dev\my-study-compiler\src\modal.ts
import { App } from "obsidian";
import type MyStudyCompilerPlugin from "./main";
import type { OpenOptions } from "./types";

export type { OpenOptions } from "./types";

/**
 * Обёртка обратной совместимости: если внешний скрипт (например, из старого кэша или DataviewJS)
 * создаёт `new StudyCompilerModal(app, plugin, opts).open()`, вызов перенаправляется в `plugin.openCompiler(opts)`
 * и открывает полноценный `StudyCompilerView` (ItemView).
 */
export class StudyCompilerModal {
	private plugin: MyStudyCompilerPlugin;
	private options: OpenOptions;

	constructor(_app: App, plugin: MyStudyCompilerPlugin, options: OpenOptions = {}) {
		this.plugin = plugin;
		this.options = options;
	}

	open(): void {
		void this.plugin.openCompiler(this.options);
	}

	close(): void {
		// no-op
	}
}