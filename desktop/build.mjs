// Bundles the desktop app into dist/. The main process and preloads are
// Node (CommonJS) bundles; the renderer pages are browser bundles. The
// prompts and Markdown renderer are shared with the extension in ../src.
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
await rm("dist", { recursive: true, force: true });
await mkdir("dist/renderer", { recursive: true });
await cp("src/renderer/panel.html", "dist/renderer/panel.html");
await cp("src/renderer/panel.css", "dist/renderer/panel.css");
await cp("src/renderer/picker.html", "dist/renderer/picker.html");
await cp("src/renderer/capture.html", "dist/renderer/capture.html");
await cp("src/renderer/voice-worklet.js", "dist/renderer/voice-worklet.js");
await cp("assets", "dist/assets", { recursive: true });
await mkdir("dist/assets/fonts", { recursive: true });
for (const [pkg, weights] of [["oxanium", [400, 500, 600, 700]], ["jetbrains-mono", [400, 500]]]) {
  for (const w of weights) {
    const name = `${pkg}-latin-${w}-normal.woff2`;
    await cp(`node_modules/@fontsource/${pkg}/files/${name}`, `dist/assets/fonts/${name}`);
  }
}

const node = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // The speech engine is a native module and stays outside the bundle.
  external: ["electron", "sherpa-onnx-node"],
  legalComments: "none",
  logLevel: "info",
};
const browser = { bundle: true, platform: "browser", format: "iife", target: "chrome130", legalComments: "none", logLevel: "info" };

const builds = [
  { ...node, entryPoints: { main: "src/main.js" }, outdir: "dist" },
  { ...node, entryPoints: { preload: "src/preload.js", "picker-preload": "src/picker-preload.js" }, outdir: "dist" },
  { ...browser, entryPoints: { panel: "src/renderer/panel.js", picker: "src/renderer/picker.js" }, outdir: "dist/renderer" },
];

if (watch) {
  for (const options of builds) (await esbuild.context(options)).watch();
} else {
  for (const options of builds) await esbuild.build(options);
}
