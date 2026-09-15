import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/index.ts", "src/cli.ts"], format: ["cjs", "esm"], target: "node18", dts: true, splitting: false, clean: true, sourcemap: true });
