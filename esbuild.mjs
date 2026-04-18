import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: production ? false : "linked",
  minify: production,
  outfile: "dist/extension.js",
  external: ["vscode", "oracledb"],
  logLevel: "info"
};

const context = await esbuild.context(buildOptions);

if (watch) {
  await context.watch();
  console.log("Watching extension sources...");
} else {
  await context.rebuild();
  await context.dispose();
}
