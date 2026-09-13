/** Public design assets only. Assessment files never live under this prefix. */
export function isProgressTestBrandAsset(pathname: string) {
  return /^\/brand\/progress-tests\/(?:logo\.png|fonts\/[a-z0-9-]+\.woff2)$/.test(pathname);
}
