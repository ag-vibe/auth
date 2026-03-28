import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "happy-dom",
  },
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    entry: {
      index: "src/index.ts",
    },
    dts: {
      tsgo: true,
    },
    exports: true,
    external: ["ofetch", "zustand", "zustand/middleware"],
    platform: "browser",
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
