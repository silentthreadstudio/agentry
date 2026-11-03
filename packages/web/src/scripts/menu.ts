/**
 * menu.ts — the phone-width site menu. The Nav renders the links as a plain stacked list; when
 * this runs, a button (aria-expanded + aria-controls) opens and closes that list instead.
 * Closes on a second tap, on Escape (focus goes back to the button), on a link click, and on a
 * tap outside the header. The minimal element shapes keep it testable without a DOM.
 */

export interface MenuButton {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: "click", listener: () => void): void;
  focus(): void;
}

export interface MenuPanel {
  classList: { toggle(token: string, force: boolean): boolean };
  addEventListener(type: "click", listener: (event: { target: unknown }) => void): void;
}

export interface MenuRoot {
  contains(node: unknown): boolean;
}

export interface MenuDocument {
  addEventListener(
    type: "keydown" | "click",
    listener: (event: { key?: string; target?: unknown }) => void,
  ): void;
}

export interface Menu {
  isOpen(): boolean;
  open(): void;
  close(options?: { restoreFocus?: boolean }): void;
  toggle(): void;
}

export const OPEN_CLASS = "is-open";

/** Wire the menu button to its panel. `isLink` decides which panel clicks close the menu. */
export function bindMenu(
  button: MenuButton,
  panel: MenuPanel,
  root: MenuRoot,
  doc: MenuDocument,
  isLink: (target: unknown) => boolean,
): Menu {
  const isOpen = () => button.getAttribute("aria-expanded") === "true";
  const set = (open: boolean) => {
    button.setAttribute("aria-expanded", String(open));
    panel.classList.toggle(OPEN_CLASS, open);
  };
  const menu: Menu = {
    isOpen,
    open: () => set(true),
    close: ({ restoreFocus = false } = {}) => {
      if (!isOpen()) return;
      set(false);
      if (restoreFocus) button.focus();
    },
    toggle: () => set(!isOpen()),
  };

  set(false);
  button.addEventListener("click", () => menu.toggle());
  panel.addEventListener("click", (event) => {
    if (isLink(event.target)) menu.close();
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape") menu.close({ restoreFocus: true });
  });
  doc.addEventListener("click", (event) => {
    if (isOpen() && !root.contains(event.target)) menu.close();
  });
  return menu;
}
