/* Four routes, so a few lines of matching rather than a dependency. See the
   2026-08-03 amendment to ADR-10. */

import { useEffect, useState } from "preact/hooks";

export type Route =
  | { name: "landing" }
  | { name: "new" }
  | { name: "generate" }
  | { name: "play"; id: string }
  | { name: "missing" };

const SESSION_ID = /^[0-9a-f]{32}$/;

export function parse(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "landing" };
  if (parts.length === 1 && parts[0] === "new") return { name: "new" };
  if (parts.length === 1 && parts[0] === "generate")
    return { name: "generate" };
  if (parts.length === 2 && parts[0] === "s" && SESSION_ID.test(parts[1]!)) {
    return { name: "play", id: parts[1]! };
  }
  return { name: "missing" };
}

/* Pushes real URLs rather than hashes, which the assets binding supports
   because `not_found_handling` returns the shell for unmatched paths. */
export function navigate(to: string): void {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parse(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  return route;
}
