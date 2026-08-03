/* The live session: one WebSocket, the document it delivers, the letters people
   type into it, and what happens when the connection goes away.

   Resilience is section 7's "client resilience" and A4: optimistic echo on type,
   reconnect with a fresh state on a drop, and retry of writes that were never
   acknowledged. The decisions about *which* writes to retry live in pending.ts,
   pure and unit-tested, because that is where a mistake is silent. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type { PeerInfo, SessionDoc, VoicePeer } from "../../types";
import type { IncomingClip } from "./voice.ts";
import { nickname as storedNickname, playerId } from "./local.ts";
import {
  confirm,
  echo,
  type Letters,
  type PendingMap,
  remember,
  retriable,
  revert,
} from "./pending.ts";

export type SessionStatus =
  | "connecting"
  | "live"
  /* Dropped, and trying again. Distinct from `closed` so the UI can say
     "reconnecting" rather than "reload the page". */
  | "reconnecting"
  /* The session is gone: expired after 30 days idle, or deleted by someone
     holding the link. Section 7 makes those indistinguishable on purpose, so
     this state has to describe both without guessing which. */
  | "missing"
  /* Ten sockets already, per the cap in section 7. */
  | "full";

export interface LiveSession {
  status: SessionStatus;
  doc: SessionDoc | null;
  peers: PeerInfo[];
  refusal: string | null;
  named: boolean;
  /* How many letters are typed but not yet acknowledged. Zero almost always. */
  waiting: number;
  introduce: (nickname: string) => void;
  setLetter: (row: number, col: number, ch: string) => void;
  clearLetter: (row: number, col: number) => void;
  /* Voice, C1. This hook is the transport only: it moves clips and knows who is
     in the room. Microphones, encoding and playback are voice.ts, because the
     two fail in completely different ways and mixing them would make a denied
     permission look like a dropped connection. */
  voicePeers: VoicePeer[];
  lastClip: IncomingClip | null;
  joinVoice: () => void;
  leaveVoice: () => void;
  sendClip: (audio: string) => void;
  /* Generation, B3. What the session is doing while it has no grid yet, so the
     play screen can render a labeled step rather than a spinner: section 11
     says 10 to 30 seconds needs words. */
  progress: { step: string; attempt: number } | null;
  failure: string | null;
}

/* Section 16 budgets a reconnect within five seconds of a drop, so the first two
   attempts happen well inside that. The last value repeats forever rather than
   the list running out: **this never gives up.**

   It did at first, after five attempts, and that was wrong in a way only trying
   it showed. A phone in a tunnel for a minute came back to "could not reconnect,
   reload the page", which is a worse outcome than waiting and is the one thing a
   solver cannot fix by waiting. A puzzle left open should still be there when the
   signal is. */
const BACKOFF_MS = [250, 750, 2000, 5000, 10_000, 15_000];

export function useSession(id: string): LiveSession {
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [doc, setDoc] = useState<SessionDoc | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [named, setNamed] = useState(false);
  const [pending, setPending] = useState<PendingMap>({});
  const [voicePeers, setVoicePeers] = useState<VoicePeer[]>([]);
  const [lastClip, setLastClip] = useState<IncomingClip | null>(null);
  const [progress, setProgress] = useState<{
    step: string;
    attempt: number;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const goneRef = useRef(false);
  /* Read inside the socket handlers, which are created once per connection and
     must not close over a stale copy of either. */
  const pendingRef = useRef<PendingMap>({});
  const nameRef = useRef<string | null>(null);
  /* The document, mirrored so a write can read the current letters without
     depending on it and without reading it inside another state updater. */
  const docRef = useRef<SessionDoc | null>(null);
  /* Whether this client wants to be in voice, which is not the same as whether
     the current socket is: the socket forgets on every reconnect. */
  const voiceRef = useRef(false);
  pendingRef.current = pending;
  docRef.current = doc;

  const me = playerId();

  useEffect(() => {
    goneRef.current = false;
    nameRef.current = storedNickname(id);

    /* A refused upgrade surfaces only as "error" through the WebSocket API, with
       no status and no body, so an expired session would be indistinguishable
       from being offline. Asking over HTTP first is what lets it say which. */
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

    /* The only place attempts are counted. Both a failed probe and a closed
       socket lead here, and incrementing in each of them burned through the
       backoff at twice the intended rate, which is how a few seconds offline
       looked like a network that was never coming back. */
    function scheduleRetry() {
      if (goneRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      const wait =
        BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)]!;
      attemptRef.current += 1;
      setStatus("reconnecting");
      timerRef.current = setTimeout(() => void connect(), wait);
    }

    async function connect() {
      if (goneRef.current) return;
      const found = await probe();
      if (goneRef.current) return;
      if (found === "gone") {
        setStatus("missing");
        return;
      }
      if (found === "unknown") {
        /* Offline rather than absent. Keep trying rather than declaring the
           puzzle gone, which would be a lie the user cannot correct. */
        scheduleRetry();
        return;
      }

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/session/${id}/ws`);
      socketRef.current = ws;

      ws.addEventListener("open", () => {
        attemptRef.current = 0;
      });

      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case "state": {
            const fresh = msg.doc as SessionDoc;
            setStatus("live");
            setDoc(fresh);

            /* Re-announce, because the server ties a nickname to a socket and
               this is a new one. The player record survives; the attachment does
               not. */
            const name = nameRef.current;
            if (name) {
              ws.send(
                JSON.stringify({ type: "hello", playerId: me, nickname: name }),
              );
              setNamed(true);
              /* Voice lives on the socket attachment, not in the document, so a
                 reconnect drops out of the room silently. Re-joining here is
                 what stops a tunnel costing somebody their voice room while
                 their letters come back on their own. Ordered after hello
                 because the server refuses voice from an unnamed socket. */
              if (voiceRef.current)
                ws.send(JSON.stringify({ type: "voice-join" }));
            }

            /* Then repair. `retriable` decides what is still safe to re-send
               given what the server just told us, which is the whole reason a
               reconnect does not quietly undo somebody else's work. */
            const outstanding = retriable(
              pendingRef.current,
              fresh.letters,
              me,
            );
            for (const write of outstanding) {
              ws.send(
                JSON.stringify(
                  write.ch === null
                    ? { type: "clear", row: write.row, col: write.col }
                    : {
                        type: "set",
                        row: write.row,
                        col: write.col,
                        ch: write.ch,
                      },
                ),
              );
            }
            /* Anything not retriable has been settled by the fresh state. */
            const stillWaiting: PendingMap = {};
            for (const write of outstanding) {
              const k = `${write.row},${write.col}`;
              const entry = pendingRef.current[k];
              if (entry) stillWaiting[k] = entry;
            }
            setPending(stillWaiting);
            break;
          }
          case "cell": {
            const { row, col, ch, at, by } = msg;
            setDoc((current) => {
              if (!current) return current;
              const letters: Letters = { ...current.letters };
              const k = `${row},${col}`;
              if (ch === null) delete letters[k];
              else letters[k] = { ch, at, by };
              return { ...current, letters };
            });
            setPending((p) => confirm(p, row, col));
            break;
          }
          case "peers":
            setPeers(msg.players as PeerInfo[]);
            break;
          case "voice-peers":
            setVoicePeers(msg.players as VoicePeer[]);
            break;
          case "progress":
            setProgress({ step: msg.step as string, attempt: msg.attempt });
            break;
          case "generated":
            setProgress(null);
            setFailure(null);
            setDoc(msg.doc as SessionDoc);
            break;
          case "failed":
            setProgress(null);
            setFailure(msg.reason as string);
            break;
          /* The model could not lay out a puzzle, so the packing happens here.
             Section 7: Workers Free allows 10 ms of CPU per request and a
             backtracking packer does not fit, so the browser does the search
             and the server validates the result. Imported lazily because a
             visitor who never generates anything should not pay for the packer
             in their bundle. */
          case "pack": {
            setProgress({ step: "packing", attempt: 0 });
            const request = msg as {
              candidates: Array<{ answer: string; clue: string }>;
              rows: number;
              cols: number;
            };
            void import("../../generate/pack.ts")
              .then(({ pack }) => {
                const packed = pack(request.candidates, {
                  rows: request.rows,
                  cols: request.cols,
                });
                if (!packed) {
                  setProgress(null);
                  setFailure("this theme did not make a puzzle. Try another.");
                  return;
                }
                return fetch(`/session/${id}/packed`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    rows: packed.rows,
                    cols: packed.cols,
                    entries: packed.entries,
                  }),
                }).then((res) => {
                  /* A 422 means the server refused what this browser packed,
                     which is a defect rather than a user error, so it says so
                     plainly instead of blaming the theme. */
                  if (!res.ok) {
                    setProgress(null);
                    setFailure(
                      res.status === 422
                        ? "the grid this device built was rejected. Try again."
                        : "could not save the puzzle. Try again.",
                    );
                  }
                });
              })
              .catch(() => {
                setProgress(null);
                setFailure("could not build the puzzle on this device.");
              });
            break;
          }
          case "clip":
            /* Stored as the newest clip rather than appended to a list. Nothing
               keeps audio around: voice.ts queues it for playback and drops it,
               and holding a history here would be storage by another name
               (invariant 15, on the client's side of it). */
            setLastClip({
              seq: msg.seq as number,
              audio: msg.audio as string,
              from: msg.from as string,
              at: msg.at as number,
            });
            break;
          case "error": {
            if (msg.message === "session full") {
              setStatus("full");
              goneRef.current = true;
              break;
            }
            setRefusal(msg.message as string);
            /* Roll back exactly the cell the server named. Without row and col
               this would be a guess, which is why they were added to the
               protocol in this milestone. */
            if (Number.isInteger(msg.row) && Number.isInteger(msg.col)) {
              const current = docRef.current;
              if (current) {
                const out = revert(
                  current.letters,
                  pendingRef.current,
                  msg.row,
                  msg.col,
                );
                pendingRef.current = out.pending;
                setPending(out.pending);
                setDoc({ ...current, letters: out.letters });
              }
            }
            break;
          }
        }
      });

      ws.addEventListener("close", () => {
        if (goneRef.current) return;
        scheduleRetry();
      });
    }

    void connect();
    return () => {
      goneRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      socketRef.current?.close();
    };
  }, [id, me]);

  const send = useCallback((message: unknown) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    /* Not open: the write stays pending and goes out on the next `state`. */
  }, []);

  const introduce = useCallback(
    (nickname: string) => {
      nameRef.current = nickname;
      send({ type: "hello", playerId: me, nickname });
      setNamed(true);
      setRefusal(null);
    },
    [send, me],
  );

  const write = useCallback(
    (row: number, col: number, ch: string | null) => {
      const current = docRef.current;
      if (!current) return;
      setRefusal(null);

      /* Computed outside any updater on purpose. Calling `setPending` from inside
         a `setDoc` updater looked fine and quietly did not happen: a state setter
         invoked during another setter's reducer is not reliably processed, so the
         letter appeared on the grid while the count of what was waiting stayed at
         zero. Both states are derived here and set plainly. */
      const next = remember(
        pendingRef.current,
        current.letters,
        row,
        col,
        ch,
        Date.now(),
      );
      pendingRef.current = next;
      setPending(next);
      setDoc({ ...current, letters: echo(current.letters, next, me) });

      send(
        ch === null
          ? { type: "clear", row, col }
          : { type: "set", row, col, ch },
      );
    },
    [send, me],
  );

  const setLetter = useCallback(
    (row: number, col: number, ch: string) => write(row, col, ch),
    [write],
  );
  const clearLetter = useCallback(
    (row: number, col: number) => write(row, col, null),
    [write],
  );

  const waiting = useMemo(() => Object.keys(pending).length, [pending]);

  const joinVoice = useCallback(() => {
    voiceRef.current = true;
    send({ type: "voice-join" });
  }, [send]);

  const leaveVoice = useCallback(() => {
    voiceRef.current = false;
    setVoicePeers([]);
    setLastClip(null);
    send({ type: "voice-leave" });
  }, [send]);

  /* `seq` counts this client's own clips. The server echoes it back untouched,
     which is what lets a sender recognize its own clip in the broadcast without
     comparing a quarter of a megabyte of base64. */
  const seqRef = useRef(0);
  const sendClip = useCallback(
    (audio: string) => {
      seqRef.current += 1;
      send({ type: "clip", seq: seqRef.current, audio });
    },
    [send],
  );

  return {
    status,
    doc,
    peers,
    refusal,
    named,
    waiting,
    introduce,
    setLetter,
    clearLetter,
    voicePeers,
    lastClip,
    joinVoice,
    leaveVoice,
    sendClip,
    progress,
    failure,
  };
}
