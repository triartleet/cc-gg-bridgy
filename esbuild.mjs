import { build, context } from "esbuild"

const opts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
}

if (process.argv.includes("--watch")) {
  const ctx = await context(opts)
  await ctx.watch()
  console.log("watching…")
} else {
  await build(opts)
}
