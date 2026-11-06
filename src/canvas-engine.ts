// C:\Users\user\dev\my-study-compiler\src\canvas-engine.ts
import {
  AnchorType,
  ArrowElement,
  BoundingBox,
  BoxCanvasElement,
  CanvasElement,
  Point,
  ResizeHandleType,
  ResizeSnapshot,
  SnapAnchorMatch,
} from "./types";

export const MIN_BOX_WIDTH = 28;
export const MIN_BOX_HEIGHT = 24;
export const SNAP_DISTANCE_PX = 28;
const ANCHOR_SIDES: readonly AnchorType[] = ["top", "bottom", "left", "right"];

export class CanvasEngine {
  static screenToCanvas(
    clientX: number,
    clientY: number,
    viewportRect: DOMRect,
    panX: number,
    panY: number,
    scale: number
  ): Point {
    const safeScale = scale > 0.001 ? scale : 1;
    return {
      x: (clientX - viewportRect.left - panX) / safeScale,
      y: (clientY - viewportRect.top - panY) / safeScale,
    };
  }

  static computeFitTransform(
    viewportWidth: number,
    viewportHeight: number,
    imgWidth: number,
    imgHeight: number,
    padding = 36
  ): { scale: number; panX: number; panY: number } {
    const safeImgW = Math.max(1, imgWidth);
    const safeImgH = Math.max(1, imgHeight);
    const availW = Math.max(100, viewportWidth - padding * 2);
    const availH = Math.max(100, viewportHeight - padding * 2);
    const fitScale = Math.min(availW / safeImgW, availH / safeImgH, 1.4);
    const scale = Math.max(0.1, Number(fitScale.toFixed(3)));
    const panX = Math.round((viewportWidth - safeImgW * scale) / 2);
    const panY = Math.round((viewportHeight - safeImgH * scale) / 2);
    return { scale, panX, panY };
  }

  static computeZoomAtPoint(
    clientX: number,
    clientY: number,
    viewportRect: DOMRect,
    currentScale: number,
    currentPanX: number,
    currentPanY: number,
    factor: number
  ): { scale: number; panX: number; panY: number } {
    const nextScale = Math.max(0.1, Math.min(6.0, currentScale * factor));
    const originX = clientX - viewportRect.left;
    const originY = clientY - viewportRect.top;
    const ratio = nextScale / currentScale;
    const panX = originX - (originX - currentPanX) * ratio;
    const panY = originY - (originY - currentPanY) * ratio;
    return { scale: nextScale, panX, panY };
  }

  static getAnchorPoint(box: BoxCanvasElement, anchor: AnchorType): Point {
    switch (anchor) {
      case "top":
        return { x: box.x + box.width / 2, y: box.y };
      case "bottom":
        return { x: box.x + box.width / 2, y: box.y + box.height };
      case "left":
        return { x: box.x, y: box.y + box.height / 2 };
      case "right":
        return { x: box.x + box.width, y: box.y + box.height / 2 };
    }
  }

  static findNearestSnapAnchor(
    point: Point,
    elements: readonly CanvasElement[],
    maxDist = SNAP_DISTANCE_PX
  ): SnapAnchorMatch | null {
    let bestDist = maxDist;
    let bestMatch: SnapAnchorMatch | null = null;

    for (const el of elements) {
      if (el.type === "arrow") continue;
      for (const anchor of ANCHOR_SIDES) {
        const pt = this.getAnchorPoint(el, anchor);
        const dist = Math.hypot(point.x - pt.x, point.y - pt.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestMatch = { id: el.id, anchor, x: pt.x, y: pt.y };
        }
      }
    }

    return bestMatch;
  }

  static syncArrowsToBlocks(elements: CanvasElement[]): Set<string> {
    const updatedArrowIds = new Set<string>();
    const boxMap = new Map<string, BoxCanvasElement>();

    for (const el of elements) {
      if (el.type !== "arrow") {
        boxMap.set(el.id, el);
      }
    }

    for (const el of elements) {
      if (el.type !== "arrow") continue;
      let changed = false;

      if (el.startElementId && el.startAnchor) {
        const target = boxMap.get(el.startElementId);
        if (target) {
          const pt = this.getAnchorPoint(target, el.startAnchor);
          const dx = pt.x - el.x1;
          const dy = pt.y - el.y1;
          if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
            el.x1 = pt.x;
            el.y1 = pt.y;
            if (el.routing === "curved" && el.cx1 !== undefined && el.cy1 !== undefined) {
              el.cx1 += dx;
              el.cy1 += dy;
            }
            changed = true;
          }
        }
      }

      if (el.endElementId && el.endAnchor) {
        const target = boxMap.get(el.endElementId);
        if (target) {
          const pt = this.getAnchorPoint(target, el.endAnchor);
          const dx = pt.x - el.x2;
          const dy = pt.y - el.y2;
          if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
            el.x2 = pt.x;
            el.y2 = pt.y;
            if (el.routing === "curved" && el.cx2 !== undefined && el.cy2 !== undefined) {
              el.cx2 += dx;
              el.cy2 += dy;
            }
            changed = true;
          }
        }
      }

      if (changed) {
        updatedArrowIds.add(el.id);
      }
    }

    return updatedArrowIds;
  }

  static getArrowControlPoints(el: ArrowElement): {
    cx1: number;
    cy1: number;
    cx2: number;
    cy2: number;
  } {
    const midX = (el.x1 + el.x2) / 2;
    return {
      cx1: typeof el.cx1 === "number" && Number.isFinite(el.cx1) ? el.cx1 : midX,
      cy1: typeof el.cy1 === "number" && Number.isFinite(el.cy1) ? el.cy1 : el.y1,
      cx2: typeof el.cx2 === "number" && Number.isFinite(el.cx2) ? el.cx2 : midX,
      cy2: typeof el.cy2 === "number" && Number.isFinite(el.cy2) ? el.cy2 : el.y2,
    };
  }

  static buildArrowPath(el: ArrowElement): string {
    if (el.routing === "curved") {
      const { cx1, cy1, cx2, cy2 } = this.getArrowControlPoints(el);
      return `M ${el.x1} ${el.y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${el.x2} ${el.y2}`;
    }

    if (el.routing === "orthogonal") {
      if (Math.abs(el.y1 - el.y2) < 5 || Math.abs(el.x1 - el.x2) < 5) {
        return `M ${el.x1} ${el.y1} L ${el.x2} ${el.y2}`;
      }
      if (el.x2 > el.x1) {
        const midX = (el.x1 + el.x2) / 2;
        return `M ${el.x1} ${el.y1} L ${midX} ${el.y1} L ${midX} ${el.y2} L ${el.x2} ${el.y2}`;
      }
      const offX = Math.max(el.x1, el.x2) + 40;
      return `M ${el.x1} ${el.y1} L ${offX} ${el.y1} L ${offX} ${el.y2} L ${el.x2} ${el.y2}`;
    }

    return `M ${el.x1} ${el.y1} L ${el.x2} ${el.y2}`;
  }

  static getElementBBox(el: CanvasElement): BoundingBox {
    if (el.type === "arrow") {
      const xs = [el.x1, el.x2];
      const ys = [el.y1, el.y2];
      if (el.routing === "curved") {
        const { cx1, cy1, cx2, cy2 } = this.getArrowControlPoints(el);
        xs.push(cx1, cx2);
        ys.push(cy1, cy2);
      }
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return {
        x: minX,
        y: minY,
        width: Math.max(4, maxX - minX),
        height: Math.max(4, maxY - minY),
      };
    }

    return {
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
    };
  }

  static boxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
    return !(
      a.x > b.x + b.width ||
      a.x + a.width < b.x ||
      a.y > b.y + b.height ||
      a.y + a.height < b.y
    );
  }

  /**
   * Вычисляет геометрию при изменении размера:
   * - для картинок (`lockAspect = true`) строго сохраняет пропорции (aspectRatio);
   * - для прямоугольников и текста (`lockAspect = false`) меняет ширину и высоту свободно.
   */
  static computeResizedGeometry(
    start: ResizeSnapshot,
    handle: ResizeHandleType,
    dx: number,
    dy: number,
    lockAspect = false
  ): { x: number; y: number; width: number; height: number } {
    const rightEdge = start.x + start.w;
    const bottomEdge = start.y + start.h;
    const centerX = start.x + start.w / 2;
    const centerY = start.y + start.h / 2;

    let x = start.x;
    let y = start.y;
    let width = start.w;
    let height = start.h;

    if (handle.includes("w")) {
      width = Math.max(MIN_BOX_WIDTH, start.w - dx);
      x = rightEdge - width;
    } else if (handle.includes("e")) {
      width = Math.max(MIN_BOX_WIDTH, start.w + dx);
    }

    if (handle.includes("n")) {
      height = Math.max(MIN_BOX_HEIGHT, start.h - dy);
      y = bottomEdge - height;
    } else if (handle.includes("s")) {
      height = Math.max(MIN_BOX_HEIGHT, start.h + dy);
    }

    if (lockAspect) {
      const ratio =
        start.aspectRatio && start.aspectRatio > 0.01
          ? start.aspectRatio
          : start.w / Math.max(1, start.h);

      if (handle.length === 2) {
        const scaleW = width / Math.max(1, start.w);
        const scaleH = height / Math.max(1, start.h);
        const s =
          Math.abs(scaleW - 1) >= Math.abs(scaleH - 1) ? scaleW : scaleH;
        width = Math.max(MIN_BOX_WIDTH, Math.round(start.w * s));
        height = Math.max(MIN_BOX_HEIGHT, Math.round(width / ratio));
        if (handle.includes("w")) x = rightEdge - width;
        if (handle.includes("n")) y = bottomEdge - height;
      } else if (handle === "e" || handle === "w") {
        height = Math.max(MIN_BOX_HEIGHT, Math.round(width / ratio));
        y = Math.round(centerY - height / 2);
      } else if (handle === "n" || handle === "s") {
        width = Math.max(MIN_BOX_WIDTH, Math.round(height * ratio));
        x = Math.round(centerX - width / 2);
      }
    }

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
  }
}