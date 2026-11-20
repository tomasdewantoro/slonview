import { useSyncExternalStore } from "react";

const query = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(query);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Follows the OS appearance (WKWebView reports macOS light/dark via prefers-color-scheme). */
export function useColorScheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, () => (window.matchMedia(query).matches ? "dark" : "light"));
}
