// routing-demo.ts — the data-driven tabbed routing demo (VISION §6.2).
// Reads the typed TASKS array and renders, for the selected task: a tab strip,
// the routed shape badge (one-shot / spec-first / decompose), the rationale, and
// a small trace. Pure DOM, no framework.
//
// Markup contract (emitted by components/RoutingDemo.astro, which YOU own):
//   <div data-routing-demo data-default="fix">
//     <!-- server-rendered fallback for the default task (works with JS off) -->
//   </div>
// The island defers its first render to when the root is visible (IntersectionObserver)
// and then replaces the fallback children with the interactive UI.
//
// No animation of its own → no reduced-motion guard needed; tab switches are
// instant. Self-initializes over every [data-routing-demo]; no-ops if none present.

import { TASKS, type Shape, type Task } from './tasks';

/** Human-facing labels + the design intent for each shape badge. */
const SHAPE_META: Record<Shape, { label: string; tone: string }> = {
  'one-shot': { label: 'one-shot', tone: 'is-one-shot' },
  'spec-first': { label: 'spec-first', tone: 'is-spec-first' },
  decompose: { label: 'decompose + verify', tone: 'is-decompose' },
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function findTask(id: string | undefined): Task {
  return TASKS.find((t) => t.id === id) ?? TASKS[0];
}

class RoutingDemo {
  private readonly tabsEl: HTMLElement;
  private readonly panelEl: HTMLElement;
  private selectedId: string;

  constructor(root: HTMLElement) {
    this.selectedId = findTask(root.dataset.default).id;

    // Replace the server-rendered fallback with the interactive scaffold.
    root.replaceChildren();
    root.classList.add('routing-demo--ready');

    this.tabsEl = el('div', 'routing-demo__tabs');
    this.tabsEl.setAttribute('role', 'tablist');
    this.tabsEl.setAttribute('aria-label', 'Example tasks');

    this.panelEl = el('div', 'routing-demo__panel');
    this.panelEl.setAttribute('role', 'tabpanel');

    root.append(this.tabsEl, this.panelEl);

    this.renderTabs();
    this.renderPanel();
  }

  private renderTabs(): void {
    this.tabsEl.replaceChildren();
    for (const task of TASKS) {
      const active = task.id === this.selectedId;
      const tab = el('button', 'routing-demo__tab', task.label);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.id = `rd-tab-${task.id}`;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      tab.classList.toggle('is-active', active);
      tab.addEventListener('click', () => this.select(task.id));
      tab.addEventListener('keydown', (ev) => this.onTabKeydown(ev, task.id));
      this.tabsEl.append(tab);
    }
  }

  private onTabKeydown(ev: KeyboardEvent, id: string): void {
    const idx = TASKS.findIndex((t) => t.id === id);
    let next = -1;
    if (ev.key === 'ArrowRight') next = (idx + 1) % TASKS.length;
    else if (ev.key === 'ArrowLeft') next = (idx - 1 + TASKS.length) % TASKS.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = TASKS.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    const nextId = TASKS[next].id;
    this.select(nextId);
    this.tabsEl.querySelector<HTMLButtonElement>(`#rd-tab-${nextId}`)?.focus();
  }

  private select(id: string): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.renderTabs();
    this.renderPanel();
  }

  private renderPanel(): void {
    const task = findTask(this.selectedId);
    const meta = SHAPE_META[task.shape];
    this.panelEl.setAttribute('aria-labelledby', `rd-tab-${task.id}`);
    this.panelEl.replaceChildren();

    const prompt = el('p', 'routing-demo__prompt');
    prompt.append(el('span', 'routing-demo__prompt-mark', '/agentry:go'), ` "${task.prompt}"`);

    const route = el('div', 'routing-demo__route');
    route.append(el('span', 'label', 'routes to'));
    route.append(el('span', `routing-demo__badge ${meta.tone}`, meta.label));

    const reason = el('p', 'routing-demo__reason muted', task.reason);

    const traceWrap = el('div', 'routing-demo__trace');
    traceWrap.append(el('span', 'label', 'trace'));
    const ol = el('ol', 'routing-demo__trace-list');
    task.trace.forEach((step) => ol.append(el('li', undefined, step)));
    traceWrap.append(ol);

    this.panelEl.append(prompt, route, reason, traceWrap);
  }
}

export function initRoutingDemo(root: ParentNode = document): void {
  const demos = Array.from(root.querySelectorAll<HTMLElement>('[data-routing-demo]'));
  if (demos.length === 0) return;

  for (const demo of demos) {
    if (typeof IntersectionObserver === 'undefined') {
      new RoutingDemo(demo); // no IO support → upgrade immediately
      continue;
    }
    const observer = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          obs.disconnect();
          new RoutingDemo(entry.target as HTMLElement);
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.1 },
    );
    observer.observe(demo);
  }
}

initRoutingDemo();
