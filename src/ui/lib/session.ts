/* The live session: one WebSocket, the document it delivers, and the letters
   people type into it.

   Deliberately not resilient yet. Optimistic echo, reconnection, and retry of an
   unacknowledged write are A4, and the seams they need are marked rather than
   filled: `status` already distinguishes the states a reconnect would move
   between, and `send` already funnels every write through one place. */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { PeerInfo, SessionDoc } from "../../types";
import { nickname as storedNickname, playerId } from "./local.ts";

export type SessionStatus =
  | "connecting"
  | "live"
  /* The session is gone: expired after 30 days idle, or deleted by someone
     holding the link. Section 7 makes those indistinguishable on purpose, so
     this state has to describe both without guessing which. */
  | "missing"
  /* Ten sockets already, per the cap in section 7. */
  | "full"
  | "closed";

export interface LiveSession {
  status: SessionStatus;
  doc: SessionDoc | null;
  peers: PeerInfo[];
  /* The most recent refusal from the server, which the UI shows verbatim
     because the server's wording is the authority on why a write failed. */
  refusal: string | null;
  named: boolean;
  introduce: (nickname: string) => void;
  setLetter: (row: number, col: number, ch: string) => void;
  clearLetter: (row: number, col: number) => void;
}

export function useSession(id: string): LiveSession {
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [doc, setDoc] = useState<SessionDoc | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [named, setNamed] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;

    /* A refused upgrade surfaces only as "error" through the WebSocket API, with
       no status and no body, so an expired session would be indistinguishable
       from being offline. Asking over HTTP first is what lets it say which.

       The photo endpoint answers both cases distinctly: "no such session" means
       gone, while "no photo yet" means a session that exists without one, which
       is an ordinary draft rather than a problem. */
    async function probe(): Promise<"gone" | "here" | "unknown"> {
      try {
        const res = await fetch(`/session/${id}/photo`);
        if (res.ok) return "here";
        const body = (await res.text()).trim();
        return body === "no such session" ? "gone" : "here";
      } catch {
        return "unknown";
      }
    }

    async function connect() {
      if ((await probe()) === "gone") {
        if (!closed) setStatus("missing");
        return;
      }
      if (closed) return;

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/session/${id}/ws`);
      socketRef.current = ws;

      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case "state":
            setDoc(msg.doc as SessionDoc);
            setStatus("live");
            break;
          case "cell": {
            const { row, col, ch, at, by } = msg;
            setDoc((current) => {
              if (!current) return current;
              const letters = { ...current.letters };
              const key = `${row},${col}`;
              if (ch === null) delete letters[key];
              else letters[key] = { ch, at, by };
              return { ...current, letters };
            });
            break;
          }
          case "peers":
            setPeers(msg.players as PeerInfo[]);
            break;
          case "error":
            /* The one refusal that is not about a write: the socket cap in
               section 7. It arrives as a frame rather than a status because a
               refused upgrade carries neither through the WebSocket API. */
            if (msg.message === "session full") setStatus("full");
            else setRefusal(msg.message as string);
            break;
        }
      });

      ws.addEventListener("close", () => {
        /* "full" and "missing" are conclusions, not transitions: keep them. */
        if (!closed) {
          setStatus((s) => (s === "missing" || s === "full" ? s : "closed"));
        }
      });
      ws.addEventListener("error", () => {
        if (!closed) setStatus((s) => (s === "live" ? "closed" : "missing"));
      });
    }

    void connect();
    return () => {
      closed = true;
      socketRef.current?.close();
    };
  }, [id]);

  const send = useCallback((message: unknown) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  /* Sent once the player has a name. A write before this is refused by the
     server with "pick a nickname first", which is a state the UI prevents
     reaching rather than merely reports. */
  const introduce = useCallback(
    (nickname: string) => {
      send({ type: "hello", playerId: playerId(), nickname });
      setNamed(true);
      setRefusal(null);
    },
    [send],
  );

  /* Rejoin automatically when this browser already named itself here. */
  useEffect(() => {
    if (status !== "live" || named) return;
    const existing = storedNickname(id);
    if (existing) introduce(existing);
  }, [status, named, id, introduce]);

  const setLetter = useCallback(
    (row: number, col: number, ch: string) => {
      setRefusal(null);
      send({ type: "set", row, col, ch });
    },
    [send],
  );

  const clearLetter = useCallback(
    (row: number, col: number) => {
      setRefusal(null);
      send({ type: "clear", row, col });
    },
    [send],
  );

  return {
    status,
    doc,
    peers,
    refusal,
    named,
    introduce,
    setLetter,
    clearLetter,
  };
}
