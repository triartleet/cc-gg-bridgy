import { build, context } from "esbuild"

// The published package ships no source map: it is larger than the bundle it
// describes, it embeds the full TypeScript source, and `.vscodeignore` already
// excludes `src/**`. Local builds keep it — pass --production (as the publish
// script does) to build without one, so the bundle carries no sourceMappingURL
// pointing at a file that was not packaged.
const production = process.argv.includes("--production")

const opts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !production,
}

if (process.argv.includes("--watch")) {
  const ctx = await context(opts)
  await ctx.watch()
  console.log("watching…")
} else {
  await build(opts)
}
