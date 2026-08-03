/* The worker's API, and the failure modes the UI has to render.

   Section 13 rule 4 requires every failure mode to have a user-facing state
   rather than only a status code, so every rejection here becomes a typed
   reason the caller can turn into a sentence. A0.5 shipped six of these with
   nowhere to show them; A1 owes `rate-limited` and `too-large`. */

import type { Cell, GridAlignment, SessionDoc } from "../../types";

export type ApiFailure =
  | { kind: "rate-limited"; message: string }
  | { kind: "too-large"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "bad-request"; message: string }
  | { kind: "offline"; message: string }
  | { kind: "unknown"; message: string };

export class ApiError extends Error {
  readonly failure: ApiFailure;
  constructor(failure: ApiFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

async function describe(res: Response): Promise<ApiFailure> {
  const body = (await res.text().catch(() => "")).trim();
  switch (res.status) {
    case 429:
      return {
        kind: "rate-limited",
        message:
          "You have made a lot of puzzles in the last hour. Try again a bit later.",
      };
    case 413:
      return {
        kind: "too-large",
        message:
          "That photo is too large even after shrinking. Try a photo taken at a lower resolution.",
      };
    case 404:
      return {
        kind: "not-found",
        message: "That puzzle does not exist, or it has expired.",
      };
    case 409:
      return { kind: "conflict", message: body || "That is already saved." };
    case 400:
    case 422:
      return {
        kind: "bad-request",
        message: body || "That request was not valid.",
      };
    default:
      return {
        kind: "unknown",
        message: body || `Something went wrong (${res.status}).`,
      };
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    /* A dropped connection is not a status code, and it is the most likely
       failure on a phone. It still needs a sentence. */
    throw new ApiError({
      kind: "offline",
      message: "Could not reach the server. Check your connection.",
    });
  }
  if (!res.ok) throw new ApiError(await describe(res));
  return res;
}

/* What the deploy knows and the bundle must not hard-code: which session, if
   any, is the demo template. Naming one stays a single configuration change. */
export async function loadConfig(): Promise<{ demoSessionId: string | null }> {
  const res = await request("/config");
  return (await res.json()) as { demoSessionId: string | null };
}

export async function createSession(): Promise<string> {
  const res = await request("/session", { method: "POST" });
  const body = (await res.json()) as { id: string };
  return body.id;
}

export async function uploadPhoto(id: string, blob: Blob): Promise<void> {
  await request(`/session/${id}/photo`, {
    method: "PUT",
    body: blob,
    headers: { "Content-Type": "image/jpeg" },
  });
}

export function photoUrl(id: string): string {
  return `/session/${id}/photo`;
}

export async function savePuzzle(
  id: string,
  puzzle: {
    title: string;
    rows: number;
    cols: number;
    alignment: GridAlignment;
    cells: Cell[][];
  },
): Promise<void> {
  await request(`/session/${id}/puzzle`, {
    method: "PUT",
    body: JSON.stringify(puzzle),
    headers: { "Content-Type": "application/json" },
  });
}

export async function cloneSession(id: string): Promise<string> {
  const res = await request(`/session/${id}/clone`, { method: "POST" });
  const body = (await res.json()) as { id: string };
  return body.id;
}

export async function deleteSession(id: string): Promise<void> {
  await request(`/session/${id}`, { method: "DELETE" });
}

/* Read-only fetch of a session document. There is no GET for the document by
   design, since `doc` is internal: the socket delivers state instead. Exported
   as a reminder rather than implemented. */
export type { SessionDoc };
