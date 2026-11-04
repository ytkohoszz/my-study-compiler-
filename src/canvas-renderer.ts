import { Component, MarkdownRenderer } from "obsidian";
import {
  ArrowElement,
  ArrowHandleType,
  CanvasElement,
  Point,
  RectElement,
  ResizeHandleType,
  TextElement,
} from "./types";
import { CanvasEngine } from "./canvas-engine";

const SVG_NS = "http://www.w3.org/2000/svg";
const RESIZE_HANDLES: readonly ResizeHandleType[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

export class CanvasRenderer {
  private elementsLayerEl: HTMLElement;
  private svgLayerEl: SVGSVGElement;
  private arrowsGroupEl: SVGGElement;
  private handlesGroupEl: SVGGElement;
  private snapIndicatorEl: SVGCircleElement;
  private notePath: string;
  private onInternalLinkClick?: (linkHref: string, newLeaf: boolean) => void;

  private htmlNodeMap: Map<string, HTMLElement> = new Map();
  private svgPathMap: Map<string, SVGPathElement> = new Map();
  private mdComponents: Map<string, Component> = new Map();

  constructor(
    elementsLayerEl: HTMLElement,
    svgLayerEl: SVGSVGElement,
    notePath: string,
    onInternalLinkClick?: (linkHref: string, newLeaf: boolean) => void
  ) {
    this.elementsLayerEl = elementsLayerEl;
    this.svgLayerEl = svgLayerEl;
    this.notePath = notePath;
    this.onInternalLinkClick = onInternalLinkClick;

    this.initSvgDefsAndLayers();
    this.arrowsGroupEl = this.svgLayerEl.querySelector(
      ".mni-svg-arrows-group"
    ) as SVGGElement;
    this.handlesGroupEl = this.svgLayerEl.querySelector(
      ".mni-svg-handles-group"
    ) as SVGGElement;
    this.snapIndicatorEl = this.svgLayerEl.querySelector(
      ".mni-snap-indicator"
    ) as SVGCircleElement;
  }

  public setNotePath(notePath: string): void {
    this.notePath = notePath;
  }

  private initSvgDefsAndLayers(): void {
    this.svgLayerEl.empty();

    const defs = document.createElementNS(SVG_NS, "defs");

    const createMarker = (id: string, refX: string, orient: string) => {
      const marker = document.createElementNS(SVG_NS, "marker");
      marker.setAttribute("id", id);
      marker.setAttribute("markerWidth", "10");
      marker.setAttribute("markerHeight", "7");
      marker.setAttribute("refX", refX);
      marker.setAttribute("refY", "3.5");
      marker.setAttribute("orient", orient);

      const poly = document.createElementNS(SVG_NS, "polygon");
      poly.setAttribute("points", "0 0, 10 3.5, 0 7");
      poly.setAttribute("fill", "#e5a158");
      marker.appendChild(poly);
      return marker;
    };

    defs.appendChild(createMarker("mni-head-end", "9", "auto"));
    defs.appendChild(createMarker("mni-head-start", "1", "auto-start-reverse"));
    this.svgLayerEl.appendChild(defs);

    const arrowsGroup = document.createElementNS(SVG_NS, "g");
    arrowsGroup.classList.add("mni-svg-arrows-group");
    this.svgLayerEl.appendChild(arrowsGroup);

    const handlesGroup = document.createElementNS(SVG_NS, "g");
    handlesGroup.classList.add("mni-svg-handles-group");
    this.svgLayerEl.appendChild(handlesGroup);

    const snapCircle = document.createElementNS(SVG_NS, "circle");
    snapCircle.classList.add("mni-snap-indicator", "is-hidden");
    snapCircle.setAttribute("r", "7");
    this.svgLayerEl.appendChild(snapCircle);
  }

  public syncLayersSize(width: number, height: number): void {
    this.elementsLayerEl.style.width = `${width}px`;
    this.elementsLayerEl.style.height = `${height}px`;
    this.svgLayerEl.style.width = `${width}px`;
    this.svgLayerEl.style.height = `${height}px`;
    this.svgLayerEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  public renderAll(
    elements: readonly CanvasElement[],
    selectedIds: ReadonlySet<string>,
    freshElementId?: string | null
  ): void {
    this.clearMarkdownComponents();
    this.elementsLayerEl.empty();
    this.arrowsGroupEl.replaceChildren();
    this.handlesGroupEl.replaceChildren();
    this.htmlNodeMap.clear();
    this.svgPathMap.clear();

    for (const el of elements) {
      const isSelected = selectedIds.has(el.id);
      const isFresh = el.id === freshElementId;

      if (el.type === "arrow") {
        const path = this.createArrowSvgElement(el, isSelected, isFresh);
        this.arrowsGroupEl.appendChild(path);
        this.svgPathMap.set(el.id, path);
      } else {
        const node = this.createBoxHtmlElement(el, isSelected, isFresh);
        this.elementsLayerEl.appendChild(node);
        this.htmlNodeMap.set(el.id, node);
      }
    }

    this.renderSelectionHandles(elements, selectedIds);
  }

  public updateElementsIncremental(
    elements: readonly CanvasElement[],
    targetIds: ReadonlySet<string>,
    selectedIds: ReadonlySet<string>
  ): void {
    for (const el of elements) {
      if (!targetIds.has(el.id)) continue;
      const isSelected = selectedIds.has(el.id);

      if (el.type === "arrow") {
        const path = this.svgPathMap.get(el.id);
        if (path) {
          this.applyArrowAttributes(path, el, isSelected);
        }
      } else {
        const node = this.htmlNodeMap.get(el.id);
        if (node) {
          this.applyBoxStyles(node, el, isSelected);
        }
      }
    }

    this.renderSelectionHandles(elements, selectedIds);
  }

  public updateSelectionStates(
    elements: readonly CanvasElement[],
    selectedIds: ReadonlySet<string>
  ): void {
    for (const el of elements) {
      const isSelected = selectedIds.has(el.id);
      if (el.type === "arrow") {
        const path = this.svgPathMap.get(el.id);
        if (path) {
          path.classList.toggle("is-selected", isSelected);
          path.setAttribute("stroke", isSelected ? "#ffffff" : el.stroke);
        }
      } else {
        const node = this.htmlNodeMap.get(el.id);
        if (node) {
          node.classList.toggle("is-selected", isSelected);
        }
      }
    }

    this.renderSelectionHandles(elements, selectedIds);
  }

  public renderSelectionHandles(
    elements: readonly CanvasElement[],
    selectedIds: ReadonlySet<string>
  ): void {
    this.handlesGroupEl.replaceChildren();
    if (selectedIds.size !== 1) return;

    const selectedId = Array.from(selectedIds)[0];
    if (!selectedId) return;

    const el = elements.find((item) => item.id === selectedId);
    if (!el) return;

    if (el.type === "arrow") {
      this.appendArrowHandles(el);
    } else {
      this.appendBoxResizeHandles(el);
    }
  }

  public showSnapIndicator(point: Point | null): void {
    if (!point) {
      this.snapIndicatorEl.classList.add("is-hidden");
      return;
    }
    this.snapIndicatorEl.setAttribute("cx", String(point.x));
    this.snapIndicatorEl.setAttribute("cy", String(point.y));
    this.snapIndicatorEl.classList.remove("is-hidden");
  }

  public getArrowsContainer(): SVGGElement {
    return this.arrowsGroupEl;
  }

  public destroy(): void {
    this.clearMarkdownComponents();
    this.htmlNodeMap.clear();
    this.svgPathMap.clear();
  }

  private clearMarkdownComponents(): void {
    for (const comp of this.mdComponents.values()) {
      comp.unload();
    }
    this.mdComponents.clear();
  }

  private createArrowSvgElement(
    el: ArrowElement,
    isSelected: boolean,
    isFresh: boolean
  ): SVGPathElement {
    const path = document.createElementNS(SVG_NS, "path");
    path.dataset.id = el.id;
    path.classList.add("mni-el-svg");
    if (isFresh) path.classList.add("is-pop-in");
    this.applyArrowAttributes(path, el, isSelected);
    return path;
  }

  private applyArrowAttributes(
    path: SVGPathElement,
    el: ArrowElement,
    isSelected: boolean
  ): void {
    path.setAttribute("d", CanvasEngine.buildArrowPath(el));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", isSelected ? "#ffffff" : el.stroke);
    path.setAttribute("stroke-width", String(el.strokeWidth));
    path.classList.toggle("is-selected", isSelected);

    if (el.endHead === "arrow") {
      path.setAttribute("marker-end", "url(#mni-head-end)");
    } else {
      path.removeAttribute("marker-end");
    }

    if (el.startHead === "arrow") {
      path.setAttribute("marker-start", "url(#mni-head-start)");
    } else {
      path.removeAttribute("marker-start");
    }
  }

  private createBoxHtmlElement(
    el: RectElement | TextElement,
    isSelected: boolean,
    isFresh: boolean
  ): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = `mni-el mni-el-${el.type}`;
    if (isFresh) wrapper.classList.add("is-pop-in");
    wrapper.dataset.id = el.id;

    this.applyBoxStyles(wrapper, el, isSelected);

    if (el.type === "text") {
      const comp = new Component();
      comp.load();
      this.mdComponents.set(el.id, comp);
      void MarkdownRenderer.renderMarkdown(el.text, wrapper, this.notePath, comp);

      wrapper.addEventListener("click", (e: MouseEvent) => {
        const linkEl = (e.target as HTMLElement | null)?.closest(
          "a.internal-link"
        ) as HTMLAnchorElement | null;
        if (!linkEl) return;
        e.preventDefault();
        e.stopPropagation();
        const href = linkEl.getAttribute("data-href") || linkEl.getAttribute("href");
        if (href && this.onInternalLinkClick) {
          this.onInternalLinkClick(href, e.ctrlKey || e.metaKey);
        }
      });
    }

    return wrapper;
  }

  private applyBoxStyles(
    node: HTMLElement,
    el: RectElement | TextElement,
    isSelected: boolean
  ): void {
    node.classList.toggle("is-selected", isSelected);
    node.style.left = `${el.x}px`;
    node.style.top = `${el.y}px`;
    node.style.width = `${el.width}px`;
    node.style.height = `${el.height}px`;

    if (el.type === "rect") {
      node.style.borderColor = el.stroke;
      node.style.borderWidth = `${el.strokeWidth}px`;
      node.style.backgroundColor = el.fill;
      node.style.borderRadius = `${el.borderRadius ?? 0}px`;
    } else if (el.type === "text") {
      node.style.color = el.color;
      node.style.fontSize = `${el.fontSize}px`;
    }
  }

  private appendArrowHandles(el: ArrowElement): void {
    const createEndpointHandle = (cx: number, cy: number, handle: ArrowHandleType) => {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", "6");
      circle.setAttribute("fill", "#e5a158");
      circle.setAttribute("stroke", "#ffffff");
      circle.setAttribute("stroke-width", "2");
      circle.classList.add("mni-arrow-handle");
      circle.dataset.handle = handle;
      circle.dataset.id = el.id;
      this.handlesGroupEl.appendChild(circle);
    };

    if (el.routing === "curved") {
      const { cx1, cy1, cx2, cy2 } = CanvasEngine.getArrowControlPoints(el);

      const createGuideLine = (x1: number, y1: number, x2: number, y2: number) => {
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(x1));
        line.setAttribute("y1", String(y1));
        line.setAttribute("x2", String(x2));
        line.setAttribute("y2", String(y2));
        line.classList.add("mni-bezier-guide");
        this.handlesGroupEl.appendChild(line);
      };

      createGuideLine(el.x1, el.y1, cx1, cy1);
      createGuideLine(el.x2, el.y2, cx2, cy2);

      const createControlHandle = (cx: number, cy: number, handle: ArrowHandleType) => {
        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("cx", String(cx));
        circle.setAttribute("cy", String(cy));
        circle.setAttribute("r", "5.5");
        circle.classList.add("mni-arrow-handle", "is-control");
        circle.dataset.handle = handle;
        circle.dataset.id = el.id;
        this.handlesGroupEl.appendChild(circle);
      };

      createControlHandle(cx1, cy1, "curve1");
      createControlHandle(cx2, cy2, "curve2");
    }

    createEndpointHandle(el.x1, el.y1, "start");
    createEndpointHandle(el.x2, el.y2, "end");
  }

  private appendBoxResizeHandles(el: RectElement | TextElement): void {
    for (const h of RESIZE_HANDLES) {
      let cx = el.x;
      let cy = el.y;

      if (h.includes("e")) cx = el.x + el.width;
      else if (h === "n" || h === "s") cx = el.x + el.width / 2;

      if (h.includes("s")) cy = el.y + el.height;
      else if (h === "e" || h === "w") cy = el.y + el.height / 2;

      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", "5.5");
      circle.classList.add("mni-resize-handle");
      circle.dataset.handle = h;
      circle.dataset.id = el.id;
      this.handlesGroupEl.appendChild(circle);
    }
  }
}