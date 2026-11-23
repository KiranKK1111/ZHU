// Regenerates the app icons the shell embeds, from their SVG source in public/:
//
//   public/zhu-mark.svg          -> src-tauri/icons/    every app icon (taskbar, window, tray, installer)
//
// The app's own UI shows the same SVG file directly, so nothing is drawn twice. The SVG is
// rendered by headless Microsoft Edge (installed with every Windows 10/11; set EDGE_PATH to use
// another Chromium browser), driven over its DevTools protocol; `tauri icon` then makes every icon
// size and the .ico.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(app, "src-tauri", "icons");

const edge =
  process.env.EDGE_PATH ??
  ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => existsSync(p));
if (!edge) throw new Error("Microsoft Edge was not found. Set EDGE_PATH to a Chromium-based browser.");

const work = mkdtempSync(join(tmpdir(), "zhu-icons-"));
try {
  await withBrowser(edge, join(work, "profile"), async (render) => {
    const png = join(work, "zhu-mark-1024.png");
    writeFileSync(png, await render(join(app, "public", "zhu-mark.svg"), 1024));
    execFileSync("npx", ["tauri", "icon", png, "--output", icons], { cwd: app, stdio: "inherit", shell: true });
    // `tauri icon` also writes macOS and mobile icon sets; ZHU is a Windows app.
    for (const extra of ["android", "ios", "icon.icns"]) rmSync(join(icons, extra), { recursive: true, force: true });
    console.log(`Icons written to ${icons}`);
  });
} finally {
  // Edge can hold its profile for a moment after it was asked to quit; a leftover temp folder is harmless.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  } catch {
    /* Windows cleans its temp folder itself */
  }
}

/**
 * Runs `use(render)` with headless Edge open, where `render(svgPath, size)` returns a transparent
 * `size` x `size` PNG of that SVG.
 */
async function withBrowser(browser, profile, use) {
  const WebSocket = createRequire(import.meta.url)("ws");
  const port = 9400 + Math.floor(Math.random() * 400);
  const proc = spawn(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
      } catch {
        /* not listening yet */
      }
      if (!target) await new Promise((r) => setTimeout(r, 150));
    }
    if (!target) throw new Error("Edge did not start.");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
    let id = 0;
    const waiting = new Map();
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.id && waiting.has(m.id)) waiting.get(m.id)(m), waiting.delete(m.id);
    });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

    let pages = 0;
    const render = async (svgPath, size) => {
      const page = join(dirname(profile), `page-${++pages}.html`);
      writeFileSync(
        page,
        `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">` +
          `<img src="data:image/svg+xml;base64,${readFileSync(svgPath).toString("base64")}" width="${size}" height="${size}" style="display:block"></body></html>`,
      );
      await send("Emulation.setDeviceMetricsOverride", { width: size, height: size, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: pathToFileURL(page).href });
      await new Promise((r) => setTimeout(r, 700));
      const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
      const data = Buffer.from(shot.result.data, "base64");
      if (data.length < 100) throw new Error(`Edge did not render ${svgPath}.`);
      return data;
    };
    await use(render);
    ws.close();
  } finally {
    // Edge runs as a tree of processes; ending only the first one leaves the rest running.
    const exited = new Promise((r) => proc.once("exit", r));
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      else proc.kill();
    } catch {
      proc.kill();
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
}
