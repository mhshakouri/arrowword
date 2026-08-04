/* Everything this browser remembers. There are no accounts (ADR-7), so the
   only record that a session exists is the link, and the only place this
   browser keeps its links is here.

   Consequence worth stating plainly: clearing site data loses the list. The
   links still work if they were saved elsewhere, and nothing on the server is
   affected. */

const VISITED = "arrowword.visited";
const PLAYER = "arrowword.playerId";
const NICKNAMES = "arrowword.nicknames";

export interface Visited {
  id: string;
  title: string;
  at: number;
  /* What kind of thing this is, so the list can say. Absent on entries written
     before B3, which is why every read tolerates it being missing rather than
     migrating: this is a convenience cache, not data, and losing a label is not
     worth a migration path. */
  kind?: "photo" | "generated";
  /* A generation that gave up. Kept in the list rather than hidden, because a
     session that silently vanishes reads as the app having lost it, and shown
     as what it is rather than as an untitled puzzle nobody can open. */
  failed?: boolean;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    /* Private browsing, a full quota, or a value someone hand-edited. None of
       those are worth breaking the page over. */
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Losing the list is survivable; failing to render is not. */
  }
}

export function visited(): Visited[] {
  return read<Visited[]>(VISITED, []).sort((a, b) => b.at - a.at);
}

export function remember(
  id: string,
  title: string,
  extra: Pick<Visited, "kind" | "failed"> = {},
): void {
  const previous = read<Visited[]>(VISITED, []).find((v) => v.id === id);
  const list = read<Visited[]>(VISITED, []).filter((v) => v.id !== id);
  /* Merged rather than replaced, so learning the title later does not forget
     what kind of puzzle it was, and learning it failed does not forget its
     name. Each caller knows one thing and none of them knows all of it. */
  list.push({ ...previous, ...extra, id, title, at: Date.now() });
  /* Sessions expire after 30 days of inactivity, so an unbounded list would
     mostly be tombstones. Keep the 30 most recent. */
  write(VISITED, list.slice(-30));
}

export function forget(id: string): void {
  write(
    VISITED,
    read<Visited[]>(VISITED, []).filter((v) => v.id !== id),
  );
}

/* A player id is 32 hex characters because the server validates it with the
   same pattern it uses for session ids. It is not a secret and proves nothing:
   it exists so a returning tab keeps its color and its attribution. */
export function playerId(): string {
  const existing = read<string | null>(PLAYER, null);
  if (existing && /^[0-9a-f]{32}$/.test(existing)) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  write(PLAYER, id);
  return id;
}

/* Nicknames are per session, not per person, so the same browser can be one
   name in one puzzle and another elsewhere. See spec section 5. */
export function nickname(sessionId: string): string | null {
  return read<Record<string, string>>(NICKNAMES, {})[sessionId] ?? null;
}

export function setNickname(sessionId: string, name: string): void {
  const all = read<Record<string, string>>(NICKNAMES, {});
  all[sessionId] = name;
  write(NICKNAMES, all);
}
