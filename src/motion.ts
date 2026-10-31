const DURATION_MS = 180;

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function animateOpen(el: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const height = el.offsetHeight;
  if (height <= 0) return;
  el.style.overflow = "hidden";
  const anim = el.animate(
    [
      { height: "0px", opacity: 0 },
      { height: `${height}px`, opacity: 1 },
    ],
    { duration: DURATION_MS, easing: "ease-out" }
  );
  const done = () => {
    el.style.overflow = "";
  };
  anim.onfinish = done;
  anim.oncancel = done;
}

export function animateClose(el: HTMLElement): Promise<void> {
  if (prefersReducedMotion()) return Promise.resolve();
  const height = el.offsetHeight;
  el.style.overflow = "hidden";
  const anim = el.animate(
    [
      { height: `${height}px`, opacity: 1 },
      { height: "0px", opacity: 0 },
    ],
    { duration: DURATION_MS, easing: "ease-in", fill: "forwards" }
  );
  return anim.finished.then(
    () => undefined,
    () => undefined
  );
}