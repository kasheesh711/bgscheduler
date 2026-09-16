/** Only relative site paths are accepted by the login UI. Auth.js also checks redirects. */
export function loginDestination(value: string | null) {
  return value && value.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u001f]/.test(value)
    ? value : "/";
}
