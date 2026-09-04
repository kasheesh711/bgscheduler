import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  outputFileTracingIncludes: {
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
