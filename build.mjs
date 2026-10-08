// Bundles src/ into dist/ and copies the static files from public/.
// Usage: npm run build   (or: npm run watch)
import * as esbuild from "esbuild";
import { cp, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await rm("dist", { recursive: true, force: true });
await cp("public", "dist", { recursive: true });

const options = {
  entryPoints: {
    background: "src/background.js",
    content: "src/content.js",
    inpage: "src/inpage.js",
    sidepanel: "src/sidepanel.js",
    options: "src/options.js",
  },
  bundle: true,
  outdir: "dist",
  // content.js is injected with chrome.scripting.executeScript, which only
  // runs classic scripts, so every entry point is built as an IIFE.
  format: "iife",
  target: "chrome120",
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
