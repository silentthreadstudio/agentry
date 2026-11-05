// Renders the README's images from the site itself, so they always match its design.
// Serves packages/web/dist (run `pnpm --filter @agentry/web build` first), drives headless Chrome
// over the DevTools protocol and writes a 2x PNG of each chosen element into assets/.
// Plain Node, no dependencies. Usage: node scripts/readme-images.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(WEB, "dist");
const ASSETS = join(WEB, "..", "..", "assets");
const WIDTH = 1280;
const SCALE = 2;

// Each shot is one element of the home page. `css` is injected before capture: every shot gets
// paper padding around the element so the crop reads as a card, and the lockup is enlarged.
const SHOTS = [
  {
    file: "agentry-lockup.png",
    selector: ".site-header .brand",
    css: ".site-header .brand{zoom:2}",
  },
  { file: "how-it-works.png", selector: "#sized .shapes" },
  { file: "lanes.png", selector: "#lanes .rows" },
  { file: "memory.png", selector: "#memory .runs" },
];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((path) => path && existsSync(path));
}

const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function serve(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function connect(chrome, profile) {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++)
    await new Promise((r) => setTimeout(r, 100));
  if (chrome.exitCode !== null) throw new Error("Chrome exited before it was ready");
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let id = 0;
  const pending = new Map();
  const waiters = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result ?? {});
    } else if (msg.method && waiters.has(msg.method)) {
      waiters.get(msg.method)();
      waiters.delete(msg.method);
    }
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        id += 1;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    once: (method) => new Promise((resolve) => waiters.set(method, resolve)),
    close: () => ws.close(),
  };
}

// Runs in the page: pads the element on paper, hides the in-page chrome, returns its box.
const prepare = (selector, css) => `(async () => {
  await document.fonts.ready;
  const style = document.createElement("style");
  style.textContent = ${JSON.stringify(css)} + \`
    ${selector} { padding: 24px !important; margin: 0 !important; background: var(--paper) !important; box-sizing: border-box; }
    *, *::before, *::after { animation: none !important; transition: none !important; }\`;
  document.head.append(style);
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error("no element matches " + ${JSON.stringify(selector)});
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
})()`;

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("no Chrome or Chromium found; set CHROME_PATH");
  if (!existsSync(join(DIST, "index.html")))
    throw new Error("packages/web/dist is missing; run `pnpm --filter @agentry/web build` first");

  const server = await serve(DIST);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = mkdtempSync(join(tmpdir(), "agentry-readme-images-"));
  const chrome = spawn(
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
  let cdp;
  try {
    cdp = await connect(chrome, profile);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: 900,
      deviceScaleFactor: SCALE,
      mobile: false,
    });
    for (const shot of SHOTS) {
      const loaded = cdp.once("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: `${origin}/` });
      await loaded;
      const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
        expression: prepare(shot.selector, shot.css ?? ""),
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails)
        throw new Error(exceptionDetails.exception?.description ?? "prepare failed");
      const { x, y, width, height } = result.value;
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x, y, width, height, scale: 1 },
      });
      writeFileSync(join(ASSETS, shot.file), Buffer.from(data, "base64"));
      console.log(`${shot.file}  ${Math.round(width * SCALE)}x${Math.round(height * SCALE)}`);
    }
  } finally {
    cdp?.close();
    if (chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await exited;
    }
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
