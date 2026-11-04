import { App, TFile, Notice } from "obsidian";
import {
  ArrowElement,
  CanvasElement,
  KEYS,
  NodePin,
  RectElement,
  TextElement,
} from "./types";

export type ElementsMap = Map<string, CanvasElement[]>;

function isFiniteNumber(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val);
}

function roundFinite(val: number, fallback = 0): number {
  return Number.isFinite(val) ? Math.round(val) : fallback;
}

export class AnnotationManager {
  private app: App;
  private file: TFile;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(app: App, file: TFile) {
    this.app = app;
    this.file = file;
  }

  public setFile(file: TFile): void {
    this.file = file;
  }

  async loadElements(
    imageWidth: number,
    imageHeight: number
  ): Promise<ElementsMap> {
    const cache = this.app.metadataCache.getFileCache(this.file);
    const frontmatter = cache?.frontmatter ?? {};

    const rawAnnotations = (frontmatter[KEYS.annotations] ?? {}) as Record<
      string,
      unknown
    >;
    const rawPins = (frontmatter[KEYS.legacyPins] ?? {}) as Record<
      string,
      unknown
    >;

    const resultMap: ElementsMap = new Map();
    let needsMigration = false;

    for (const [imgName, elements] of Object.entries(rawAnnotations)) {
      if (!Array.isArray(elements)) continue;

      const typedElements: CanvasElement[] = [];
      for (const rawEl of elements) {
        if (!rawEl || typeof rawEl !== "object") continue;
        const el = rawEl as CanvasElement;

        if (el.type === "arrow") {
          const arrow: ArrowElement = {
            ...el,
            x1: roundFinite(el.x1, 0),
            y1: roundFinite(el.y1, 0),
            x2: roundFinite(el.x2, 100),
            y2: roundFinite(el.y2, 100),
            routing: el.routing ?? "straight",
            startHead: el.startHead ?? "none",
            endHead: el.endHead ?? "arrow",
            stroke: el.stroke || "#e5a158",
            strokeWidth: isFiniteNumber(el.strokeWidth) ? el.strokeWidth : 2,
          };
          if (isFiniteNumber(el.cx1)) arrow.cx1 = roundFinite(el.cx1);
          else delete arrow.cx1;
          if (isFiniteNumber(el.cy1)) arrow.cy1 = roundFinite(el.cy1);
          else delete arrow.cy1;
          if (isFiniteNumber(el.cx2)) arrow.cx2 = roundFinite(el.cx2);
          else delete arrow.cx2;
          if (isFiniteNumber(el.cy2)) arrow.cy2 = roundFinite(el.cy2);
          else delete arrow.cy2;

          typedElements.push(arrow);
        } else if (el.type === "rect") {
          const rect: RectElement = {
            ...el,
            x: roundFinite(el.x, 0),
            y: roundFinite(el.y, 0),
            width: Math.max(10, roundFinite(el.width, 100)),
            height: Math.max(10, roundFinite(el.height, 60)),
            stroke: el.stroke || "#e5a158",
            strokeWidth: isFiniteNumber(el.strokeWidth) ? el.strokeWidth : 2,
            fill: el.fill || "rgba(229, 161, 88, 0.1)",
            borderRadius: isFiniteNumber(el.borderRadius) ? el.borderRadius : 0,
          };
          typedElements.push(rect);
        } else if (el.type === "text") {
          const textEl: TextElement = {
            ...el,
            x: roundFinite(el.x, 0),
            y: roundFinite(el.y, 0),
            width: Math.max(40, roundFinite(el.width, 200)),
            height: Math.max(24, roundFinite(el.height, 48)),
            text: typeof el.text === "string" ? el.text : "",
            fontSize: isFiniteNumber(el.fontSize) ? Math.max(8, el.fontSize) : 16,
            color: el.color || "#ffffff",
          };
          typedElements.push(textEl);
        }
      }

      resultMap.set(imgName, typedElements);
    }

    if (Object.keys(rawPins).length > 0) {
      for (const [imgName, pins] of Object.entries(rawPins)) {
        if (Array.isArray(pins) && !resultMap.has(imgName)) {
          const migratedElements: TextElement[] = pins.map((p, idx) => {
            const oldPin = p as NodePin;
            return {
              id: `migrated_${idx}_${Date.now()}`,
              type: "text",
              x: roundFinite(oldPin.x * imageWidth, 0),
              y: roundFinite(oldPin.y * imageHeight, 0),
              width: 200,
              height: 60,
              text: oldPin.text,
              fontSize: 16,
              color: "#e5a158",
            };
          });
          resultMap.set(imgName, migratedElements);
          needsMigration = true;
        }
      }
    }

    if (needsMigration) {
      await this.saveElements(resultMap);
      await this.app.fileManager.processFrontMatter(
        this.file,
        (fm: Record<string, unknown>) => {
          delete fm[KEYS.legacyPins];
        }
      );
      new Notice("Старые пины перенесены в новый формат!");
    }

    return resultMap;
  }

  async saveElements(elementsMap: ElementsMap): Promise<void> {
    const targetFile = this.file;
    const rawToSave: Record<string, CanvasElement[]> = {};

    for (const [imgName, list] of elementsMap.entries()) {
      if (list.length === 0) continue;

      rawToSave[imgName] = list.map((el): CanvasElement => {
        if (el.type === "arrow") {
          const savedArrow: ArrowElement = {
            id: el.id,
            type: "arrow",
            x1: roundFinite(el.x1),
            y1: roundFinite(el.y1),
            x2: roundFinite(el.x2),
            y2: roundFinite(el.y2),
            routing: el.routing,
            startHead: el.startHead,
            endHead: el.endHead,
            stroke: el.stroke,
            strokeWidth: roundFinite(el.strokeWidth, 2),
          };
          if (isFiniteNumber(el.cx1)) savedArrow.cx1 = roundFinite(el.cx1);
          if (isFiniteNumber(el.cy1)) savedArrow.cy1 = roundFinite(el.cy1);
          if (isFiniteNumber(el.cx2)) savedArrow.cx2 = roundFinite(el.cx2);
          if (isFiniteNumber(el.cy2)) savedArrow.cy2 = roundFinite(el.cy2);
          if (el.startElementId) savedArrow.startElementId = el.startElementId;
          if (el.startAnchor) savedArrow.startAnchor = el.startAnchor;
          if (el.endElementId) savedArrow.endElementId = el.endElementId;
          if (el.endAnchor) savedArrow.endAnchor = el.endAnchor;
          return savedArrow;
        }

        if (el.type === "rect") {
          const savedRect: RectElement = {
            id: el.id,
            type: "rect",
            x: roundFinite(el.x),
            y: roundFinite(el.y),
            width: Math.max(10, roundFinite(el.width, 20)),
            height: Math.max(10, roundFinite(el.height, 20)),
            stroke: el.stroke,
            strokeWidth: roundFinite(el.strokeWidth, 2),
            fill: el.fill,
            borderRadius: roundFinite(el.borderRadius ?? 0, 0),
          };
          return savedRect;
        }

        const savedText: TextElement = {
          id: el.id,
          type: "text",
          x: roundFinite(el.x),
          y: roundFinite(el.y),
          width: Math.max(40, roundFinite(el.width, 100)),
          height: Math.max(24, roundFinite(el.height, 40)),
          text: el.text,
          fontSize: Math.max(8, roundFinite(el.fontSize, 16)),
          color: el.color,
        };
        return savedText;
      });
    }

    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(async () => {
        await this.app.fileManager.processFrontMatter(
          targetFile,
          (fm: Record<string, unknown>) => {
            if (Object.keys(rawToSave).length === 0) {
              delete fm[KEYS.annotations];
            } else {
              fm[KEYS.annotations] = rawToSave;
            }
          }
        );
      });

    try {
      await this.saveQueue;
    } catch (e: unknown) {
      new Notice(
        "Ошибка сохранения схемы: " +
          (e instanceof Error ? e.message : String(e))
      );
    }
  }
}