// Narrow-phone layout guard: at 320, 360 and 375 px the header and the page must fit the
// screen with no horizontal scroll. Builds the site, serves dist/ on a local port, and loads
// each page in headless Chrome over the DevTools protocol. Skips (with a reason) when no
// Chrome or Chromium is installed.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(WEB, "dist");
const WIDTHS = [320, 360, 375];
const PAGES = ["/", "/docs/security/", "/404.html"];

function findChrome(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((path): path is string => Boolean(path && existsSync(path)));
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serve(root: string): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

type Cdp = {
  send: (method: string, params?: object) => Promise<Record<string, unknown>>;
  once: (method: string) => Promise<void>;
  close: () => void;
};

async function connect(chrome: ChildProcess, profile: string): Promise<Cdp> {
  const portFile = join(profile, "DevToolsActivePort");
  // A cold Chrome on a busy CI runner can take well over 10 s to write its port file.
  for (let i = 0; i < 300 && !existsSync(portFile) && chrome.exitCode === null; i++)
    await new Promise((r) => setTimeout(r, 100));
  if (chrome.exitCode !== null) throw new Error("Chrome exited before it was ready");
  if (!existsSync(portFile)) throw new Error("Chrome did not open its debugging port within 30 s");
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let id = 0;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  const waiters = new Map<string, () => void>();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)?.(msg.result ?? {});
      pending.delete(msg.id);
    } else if (msg.method && waiters.has(msg.method)) {
      waiters.get(msg.method)?.();
      waiters.delete(msg.method);
    }
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        id += 1;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      }),
    once: (method) => new Promise((resolve) => waiters.set(method, resolve)),
    close: () => ws.close(),
  };
}

const chromePath = findChrome();
let server: Server | undefined;
let chrome: ChildProcess | undefined;
let profile = "";
let cdp: Cdp | undefined;
let origin = "";

before(async () => {
  if (!chromePath) return;
  execFileSync("pnpm", ["exec", "astro", "build"], { cwd: WEB, stdio: "ignore" });
  server = await serve(DIST);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profile = mkdtempSync(join(tmpdir(), "agentry-web-overflow-"));
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  cdp = await connect(chrome, profile);
  await cdp.send("Page.enable");
});

after(async () => {
  cdp?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome?.once("exit", resolve));
    chrome.kill();
    await exited;
  }
  server?.close();
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const header = document.querySelector("header");
  const parts = header ? [header, ...header.querySelectorAll(".brand, .cta, .menu-btn")] : [];
  const spill = parts
    .filter((el) => getComputedStyle(el).display !== "none")
    .map((el) => ({ name: el.className || el.tagName, right: Math.round(el.getBoundingClientRect().right) }))
    .filter((p) => p.right > vw);
  return { path: location.pathname, vw, scrollWidth: document.documentElement.scrollWidth, spill };
})()`;

for (const width of WIDTHS) {
  for (const page of PAGES) {
    test(
      `no horizontal overflow at ${width}px on ${page}`,
      { skip: !chromePath && "no Chrome or Chromium installed" },
      async () => {
        assert.ok(cdp, "Chrome is not connected");
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 800,
          deviceScaleFactor: 1,
          mobile: true,
        });
        const loaded = cdp.once("Page.loadEventFired");
        await cdp.send("Page.navigate", { url: `${origin}${page}` });
        await loaded;
        const result = (await cdp.send("Runtime.evaluate", {
          expression: `document.fonts.ready.then(() => ${MEASURE})`,
          awaitPromise: true,
          returnByValue: true,
        })) as {
          result: { value: { path: string; vw: number; scrollWidth: number; spill: unknown[] } };
        };
        const { path, vw, scrollWidth, spill } = result.result.value;
        assert.equal(path, page, "the page did not load");
        assert.equal(vw, width, "the viewport did not take the emulated width");
        assert.deepEqual(spill, [], "a header item reaches past the screen edge");
        assert.ok(scrollWidth <= vw, `the page scrolls sideways: ${scrollWidth}px wide in ${vw}px`);
      },
    );
  }
}
