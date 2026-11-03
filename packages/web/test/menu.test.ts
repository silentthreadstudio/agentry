import assert from "node:assert/strict";
import { test } from "node:test";
import { OPEN_CLASS, bindMenu } from "../src/scripts/menu.ts";

type Listener = (event: { key?: string; target?: unknown }) => void;

function fakeTarget() {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener(type: string, listener: Listener) {
      listeners[type] ??= [];
      listeners[type].push(listener);
    },
    fire(type: string, event: { key?: string; target?: unknown } = {}) {
      for (const listener of listeners[type] ?? []) listener(event);
    },
  };
}

function setup() {
  const attrs: Record<string, string> = {};
  let focused = 0;
  const button = {
    ...fakeTarget(),
    getAttribute: (name: string) => attrs[name] ?? null,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    focus: () => {
      focused += 1;
    },
  };
  const classes = new Set<string>();
  const panel = {
    ...fakeTarget(),
    classList: {
      toggle: (token: string, force: boolean) => {
        if (force) classes.add(token);
        else classes.delete(token);
        return force;
      },
    },
  };
  const link = { kind: "link" };
  const inside = { kind: "inside" };
  const outside = { kind: "outside" };
  const root = { contains: (node: unknown) => node === link || node === inside || node === button };
  const doc = fakeTarget();
  const menu = bindMenu(button, panel, root, doc, (target) => target === link);
  return {
    menu,
    button,
    panel,
    doc,
    link,
    inside,
    outside,
    expanded: () => attrs["aria-expanded"],
    panelOpen: () => classes.has(OPEN_CLASS),
    focused: () => focused,
  };
}

test("starts closed with aria-expanded=false", () => {
  const m = setup();
  assert.equal(m.expanded(), "false");
  assert.equal(m.panelOpen(), false);
});

test("a tap opens the menu and a second tap closes it", () => {
  const m = setup();
  m.button.fire("click");
  assert.equal(m.expanded(), "true");
  assert.equal(m.panelOpen(), true);
  m.button.fire("click");
  assert.equal(m.expanded(), "false");
  assert.equal(m.panelOpen(), false);
});

test("Escape closes an open menu and returns focus to the button", () => {
  const m = setup();
  m.button.fire("click");
  m.doc.fire("keydown", { key: "Escape" });
  assert.equal(m.expanded(), "false");
  assert.equal(m.panelOpen(), false);
  assert.equal(m.focused(), 1);
});

test("Escape on a closed menu does nothing and steals no focus", () => {
  const m = setup();
  m.doc.fire("keydown", { key: "Escape" });
  assert.equal(m.focused(), 0);
});

test("other keys leave the menu open", () => {
  const m = setup();
  m.button.fire("click");
  m.doc.fire("keydown", { key: "Tab" });
  assert.equal(m.menu.isOpen(), true);
});

test("following a link closes the menu", () => {
  const m = setup();
  m.button.fire("click");
  m.panel.fire("click", { target: m.link });
  assert.equal(m.menu.isOpen(), false);
});

test("a tap inside the header but not on a link keeps it open", () => {
  const m = setup();
  m.button.fire("click");
  m.panel.fire("click", { target: m.inside });
  m.doc.fire("click", { target: m.inside });
  assert.equal(m.menu.isOpen(), true);
});

test("a tap outside the header closes it", () => {
  const m = setup();
  m.button.fire("click");
  m.doc.fire("click", { target: m.outside });
  assert.equal(m.menu.isOpen(), false);
});
