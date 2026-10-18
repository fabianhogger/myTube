import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "data/**", "fixtures/**"]),
  {
    // These modules walk JSON and XML that YouTube can reshape at any time, and
    // raw SQL rows. `any` is the honest type there: a hand-written interface
    // would be fiction, and the tolerant path walks are the actual safety net.
    files: [
      "src/ingest/scrape/renderers.ts",
      "src/ingest/rss/parse.ts",
      "src/ingest/google/videos-list.ts",
      "src/lib/db.ts",
      "scripts/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-var": "off",
    },
  },
]);

export default eslintConfig;
