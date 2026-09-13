/** Pure page-prefix check shared by session authorization and outbound scopes. */
export function hasPageAccess(allowedPages: string[] | null | undefined, route: string) {
  return !allowedPages || allowedPages.some(page => route === page || route.startsWith(`${page}/`));
}
