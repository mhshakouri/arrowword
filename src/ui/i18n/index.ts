/* Which language, and how components find out. ADR-16.

   The choice lives in this module rather than in a context provider: `api.ts`
   and `photo.ts` throw user-facing sentences from outside the component tree,
   so the dictionary has to be reachable without a hook. The hook exists only
   to re-render on change. */

import { useEffect, useReducer } from "preact/hooks";
import type { Messages } from "./messages.ts";
import { en } from "./en.ts";
import { fa } from "./fa.ts";

export type Lang = "en" | "fa";

const KEY = "arrowword:lang";

function initial(): Lang {
  /* localStorage can throw in private windows and when storage is blocked, and
     a language toggle must never be the thing that breaks the app. */
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "fa") return saved;
  } catch {
    /* Fall through to the browser's language. */
  }
  return /^fa\b/i.test(navigator.language ?? "") ? "fa" : "en";
}

let current: Lang = initial();
const listeners = new Set<() => void>();

/* The document direction follows the UI language. Puzzle boards do not: a
   generated English crossword stays LTR inside Persian chrome, which is why
   the board components carry their own `dir` from the puzzle's `lang`. */
function apply() {
  document.documentElement.lang = current;
  document.documentElement.dir = current === "fa" ? "rtl" : "ltr";
}
apply();

export function lang(): Lang {
  return current;
}

export function setLang(next: Lang): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* The switch still works for this page view; it just will not stick. */
  }
  apply();
  for (const notify of listeners) notify();
}

/* For code outside components. Read it at use time, never at module load:
   a string captured at import would be frozen in the boot language. */
export function t(): Messages {
  return current === "fa" ? fa : en;
}

export function useLang(): Lang {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const notify = () => bump(undefined);
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, []);
  return current;
}

export function useT(): Messages {
  useLang();
  return t();
}
