import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "highs"],
  outputFileTracingIncludes: {
    "/api/class-assignments": ["./node_modules/highs/build/**/*"],
    "/api/class-assignments/**": ["./node_modules/highs/build/**/*"],
    "/api/internal/class-assignments/**": ["./node_modules/highs/build/**/*"],
    "/api/data-health/jobs/*/run": ["./node_modules/highs/build/**/*"],
    "/api/progress-tests/workspace": ["./public/brand/progress-tests/**/*", "./node_modules/@sparticuz/chromium/bin/**/*", "./node_modules/jszip/dist/jszip.min.js", "./node_modules/docx-preview/dist/docx-preview.min.js", "./node_modules/katex/dist/**/*", "./node_modules/pdfjs-dist/{legacy/build,standard_fonts,cmaps,wasm}/**/*"],
    "/api/internal/progress-tests/process": ["./public/brand/progress-tests/**/*", "./node_modules/@sparticuz/chromium/bin/**/*", "./node_modules/jszip/dist/jszip.min.js", "./node_modules/docx-preview/dist/docx-preview.min.js", "./node_modules/katex/dist/**/*", "./node_modules/pdfjs-dist/{legacy/build,standard_fonts,cmaps,wasm}/**/*"],
    "/api/progress-tests/workspace/pdf-runtime/*": ["./node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "./node_modules/pdfjs-dist/{standard_fonts,cmaps,wasm}/**/*"],
    "/api/onsite-foot-traffic/reports/*/html": [
      "./node_modules/@fontsource/sarabun/files/*.woff2",
      "./node_modules/@fontsource/cormorant-garamond/files/*.woff2",
      "./public/brand/logo-horizontal.png",
    ],
    "/api/onsite-foot-traffic/reports/*/pdf": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
      "./node_modules/@fontsource/sarabun/files/*.woff2",
      "./node_modules/@fontsource/cormorant-garamond/files/*.woff2",
      "./public/brand/logo-horizontal.png",
    ],
  },
};

export default nextConfig;
