// ConstellationNet.ts — the hero canvas node-graph (VISION §6.1).
// A seeded, deterministic constellation: amber→violet nodes drifting gently,
// distance-based edges under a radial mask, mouse repulsion, and a slowly
// drifting aurora glow. Orchestration as a living network — calm, not a screensaver.
//
// Markup contract (emitted by Hero, T5):
//   <canvas data-constellation aria-hidden="true"></canvas>
// The canvas fills its positioned parent (sized from the parent's client box, DPR-aware).
//
// Discipline (VISION §6 / AC4):
//   - Seeded RNG (mulberry32) — no Math.random() jitter between loads.
//   - devicePixelRatio-aware; re-sizes with the parent (ResizeObserver).
//   - Pauses when offscreen (IntersectionObserver) and when the tab is hidden.
//   - Reduced-motion: render a single calm static frame, no rAF loop.
//   - Self-initializes over every [data-constellation]; no-ops if none present.

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Deterministic PRNG (mulberry32) — same layout every load. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** 0 = amber, 1 = violet — fixed per node so the palette is deterministic. */
  hueT: number;
}

const SEED = 0x5eed1234;
const EDGE_DIST = 140; // px (CSS space) — edges drawn under this node distance
const MOUSE_RADIUS = 120; // px — repulsion reach
const MOUSE_FORCE = 26; // px — max displacement at the cursor
const DRIFT = 0.12; // px/frame base velocity scale
const AMBER = { r: 244, g: 169, b: 60 }; // --amber #f4a93c
const VIOLET = { r: 139, g: 92, b: 246 }; // --violet #8b5cf6

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function nodeColor(hueT: number, alpha: number): string {
  const r = Math.round(lerp(AMBER.r, VIOLET.r, hueT));
  const g = Math.round(lerp(AMBER.g, VIOLET.g, hueT));
  const b = Math.round(lerp(AMBER.b, VIOLET.b, hueT));
  return `rgba(${r},${g},${b},${alpha})`;
}

class Constellation {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private nodes: Node[] = [];
  private w = 0; // CSS px
  private h = 0; // CSS px
  private dpr = 1;
  private mouseX = -9999;
  private mouseY = -9999;
  private frame = 0;
  private rafId = 0;
  private running = false;
  private visible = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.resize();
    this.seedNodes();

    const parent = canvas.parentElement ?? canvas;
    parent.addEventListener('pointermove', this.onPointerMove);
    parent.addEventListener('pointerleave', this.onPointerLeave);

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        this.resize();
        this.seedNodes(); // re-seed (deterministically) for the new box
        if (!this.running) this.renderStatic();
      }).observe(parent);
    }

    if (REDUCED) {
      this.renderStatic();
      return;
    }

    this.observeVisibility(parent);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.start();
  }

  private parentBox(): { w: number; h: number } {
    const parent = this.canvas.parentElement;
    const rect = parent
      ? parent.getBoundingClientRect()
      : this.canvas.getBoundingClientRect();
    return { w: Math.max(1, rect.width), h: Math.max(1, rect.height) };
  }

  private resize(): void {
    const { w, h } = this.parentBox();
    this.w = w;
    this.h = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR for perf
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // draw in CSS px
  }

  private seedNodes(): void {
    // Density scales with area but is capped — keeps the edge loop O(n²) cheap.
    const target = Math.round((this.w * this.h) / 16000);
    const count = Math.max(18, Math.min(target, 64));
    const rand = mulberry32(SEED); // fresh deterministic stream per (re)seed
    this.nodes = Array.from({ length: count }, () => ({
      x: rand() * this.w,
      y: rand() * this.h,
      vx: (rand() - 0.5) * DRIFT,
      vy: (rand() - 0.5) * DRIFT,
      r: 1.1 + rand() * 1.9,
      hueT: rand(),
    }));
  }

  private observeVisibility(parent: Element): void {
    if (typeof IntersectionObserver === 'undefined') return;
    new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          this.visible = e.isIntersecting;
          if (this.visible && !document.hidden) this.start();
          else this.stop();
        }
      },
      { threshold: 0 },
    ).observe(parent);
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.stop();
    else if (this.visible) this.start();
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseX = ev.clientX - rect.left;
    this.mouseY = ev.clientY - rect.top;
  };

  private readonly onPointerLeave = (): void => {
    this.mouseX = -9999;
    this.mouseY = -9999;
  };

  private start(): void {
    if (this.running || REDUCED) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.loop);
  }

  private stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private readonly loop = (): void => {
    if (!this.running) return;
    this.frame += 1;
    this.step();
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  /** Advance node positions: drift, bounce off edges, mouse repulsion. */
  private step(): void {
    for (const n of this.nodes) {
      n.x += n.vx;
      n.y += n.vy;

      if (n.x < 0 || n.x > this.w) n.vx *= -1;
      if (n.y < 0 || n.y > this.h) n.vy *= -1;
      n.x = Math.max(0, Math.min(this.w, n.x));
      n.y = Math.max(0, Math.min(this.h, n.y));

      const dx = n.x - this.mouseX;
      const dy = n.y - this.mouseY;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < MOUSE_RADIUS) {
        const push = (1 - d / MOUSE_RADIUS) * MOUSE_FORCE;
        n.x += (dx / d) * push * 0.08;
        n.y += (dy / d) * push * 0.08;
      }
    }
  }

  /** Radial mask: edges fade toward the canvas corners (denser at center). */
  private edgeMaskAlpha(x: number, y: number): number {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const maxR = Math.hypot(cx, cy) || 1;
    const r = Math.hypot(x - cx, y - cy) / maxR;
    return Math.max(0, 1 - r * 0.9);
  }

  /** Aurora glow: two soft radial blobs that drift slowly via cheap trig. */
  private drawAurora(): void {
    const { ctx, w, h } = this;
    const t = this.frame * 0.0016;
    const blobs = [
      {
        x: w * (0.32 + 0.06 * Math.sin(t)),
        y: h * (0.34 + 0.05 * Math.cos(t * 0.8)),
        color: VIOLET,
        a: 0.1,
      },
      {
        x: w * (0.7 + 0.05 * Math.cos(t * 0.7)),
        y: h * (0.6 + 0.06 * Math.sin(t * 1.1)),
        color: AMBER,
        a: 0.07,
      },
    ];
    for (const b of blobs) {
      const radius = Math.max(w, h) * 0.5;
      const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, radius);
      grad.addColorStop(0, `rgba(${b.color.r},${b.color.g},${b.color.b},${b.a})`);
      grad.addColorStop(1, `rgba(${b.color.r},${b.color.g},${b.color.b},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
  }

  private draw(): void {
    const { ctx, w, h, nodes } = this;
    ctx.clearRect(0, 0, w, h);
    this.drawAurora();

    // edges first, under the nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist >= EDGE_DIST) continue;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const proximity = 1 - dist / EDGE_DIST;
        const alpha = proximity * 0.5 * this.edgeMaskAlpha(mx, my);
        if (alpha <= 0.01) continue;
        ctx.strokeStyle = nodeColor((a.hueT + b.hueT) / 2, alpha);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // nodes on top, with a soft glow
    for (const n of nodes) {
      ctx.fillStyle = nodeColor(n.hueT, 0.9);
      ctx.shadowColor = nodeColor(n.hueT, 0.6);
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  /** One calm frame, no loop — the reduced-motion / paused presentation. */
  private renderStatic(): void {
    this.draw();
  }
}

export function initConstellation(root: ParentNode = document): void {
  const canvases = Array.from(
    root.querySelectorAll<HTMLCanvasElement>('canvas[data-constellation]'),
  );
  if (canvases.length === 0) return;
  for (const canvas of canvases) {
    try {
      new Constellation(canvas);
    } catch {
      // canvas unsupported — leave the (aria-hidden) element empty; page still works
    }
  }
}

initConstellation();
