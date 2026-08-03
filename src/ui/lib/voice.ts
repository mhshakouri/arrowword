/* Push to talk: capture, encode, and play back short voice clips.

   Everything here exists because of one constraint recorded in ADR-14. The
   people this feature is for are on a network where WhatsApp and Telegram are
   unreachable, so the audio has to travel over the WebSocket that is already
   delivering the puzzle. That rules out WebRTC and it also rules out
   `MediaRecorder`: Safari records to mp4/aac, Chrome to webm/opus, and Safari
   cannot play webm at all, so a recorded container needs a transcode somewhere.
   Raw PCM in a WAV wrapper needs none: `decodeAudioData` reads it everywhere.

   The cost is bytes. 16 kHz mono 16-bit is about ten times an Opus stream of the
   same speech. Section 7 caps a clip at 8 seconds for exactly that reason, and
   ADR-14 records µ-law and then Opus as the two ways to shrink it if a slow
   connection ever makes it hurt. */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  downsample,
  encodeWav,
  TARGET_SAMPLE_RATE,
  toBase64,
  fromBase64,
} from "./wav.ts";

/* Section 7. The client stops at the ceiling rather than letting the server
   refuse a clip somebody already spoke, which is a worse experience for the
   same outcome. The server still enforces it (invariant 18). */
const MAX_CLIP_SECONDS = 8;

export type VoiceState =
  /* Not in the room. No microphone has been touched (invariant 14). */
  | "off"
  | "joining"
  | "ready"
  | "recording"
  /* Every failure below is a state rather than a console message, because
     section 13 rule 4 wants a person to be told what went wrong. */
  | "denied"
  | "unsupported"
  | "failed";

export interface IncomingClip {
  seq: number;
  audio: string;
  from: string;
  at: number;
}

export interface Voice {
  state: VoiceState;
  /* The playerId currently being played back, so the UI can light up whoever is
     talking using the colors A5 already assigned. */
  speaking: string | null;
  /* Seconds held so far, for a progress ring against MAX_CLIP_SECONDS. */
  held: number;
  join: () => void;
  leave: () => void;
  startTalking: () => void;
  stopTalking: () => void;
}

/* A secure context is required for both the microphone and `AudioWorklet`, so
   an http:// origin fails here rather than at the permission prompt. */
export function voiceSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    window.isSecureContext
  );
}

/* Inline rather than a separate file fed through the bundler. `addModule` takes
   a URL, and a blob URL keeps the processor next to the code that uses it
   instead of in `public/` where a future asset change could silently break it.
   The processor does nothing but forward frames: all the work is on the main
   thread, where it can be tested and read. */
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor("capture", Capture);
`;

export function useVoice(
  inVoice: boolean,
  lastClip: IncomingClip | null,
  send: (audio: string) => void,
  join: () => void,
  leave: () => void,
): Voice {
  const [state, setState] = useState<VoiceState>("off");
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [held, setHeld] = useState(0);

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const recordingRef = useRef(false);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /* Clips play one after another. Two people answering at once would otherwise
     be mixed into noise that is neither of them. */
  const queueRef = useRef<IncomingClip[]>([]);
  const playingRef = useRef(false);
  /* Guards against a clip that starts and never finishes. See the watchdog
     below: without it a suspended context stalls the queue permanently. */
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teardown = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    if (heldTimerRef.current) clearInterval(heldTimerRef.current);
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    /* Stopping every track is what turns the browser's recording indicator off.
       Leaving them live would keep the microphone open after someone left the
       room, which is exactly the thing invariant 14 exists to prevent. */
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    chunksRef.current = [];
    recordingRef.current = false;
    queueRef.current = [];
    playingRef.current = false;
  }, []);

  useEffect(() => teardown, [teardown]);

  const doJoin = useCallback(() => {
    if (!voiceSupported()) {
      setState("unsupported");
      return;
    }
    setState("joining");
    /* The `AudioContext` is created inside the tap that joins, because iOS will
       not let one produce sound unless it was created or resumed during a user
       gesture. A listener who never presses talk still needs to hear people,
       and this is the only gesture they are guaranteed to make. */
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        const ctx = new AudioContext();
        await ctx.resume();
        const url = URL.createObjectURL(
          new Blob([CAPTURE_WORKLET], { type: "application/javascript" }),
        );
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        const node = new AudioWorkletNode(ctx, "capture");
        node.port.onmessage = (event: MessageEvent) => {
          if (recordingRef.current)
            chunksRef.current.push(event.data as Float32Array);
        };
        /* Connected to the source only. Nothing routes to `ctx.destination`,
           so a player never hears their own microphone. */
        ctx.createMediaStreamSource(stream).connect(node);

        ctxRef.current = ctx;
        streamRef.current = stream;
        nodeRef.current = node;
        setState("ready");
        join();
      } catch (error) {
        teardown();
        const name = (error as DOMException | undefined)?.name;
        setState(
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : "failed",
        );
      }
    })();
  }, [join, teardown]);

  const doLeave = useCallback(() => {
    teardown();
    setState("off");
    setSpeaking(null);
    setHeld(0);
    leave();
  }, [leave, teardown]);

  const stopTalking = useCallback(() => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    if (heldTimerRef.current) clearInterval(heldTimerRef.current);
    setHeld(0);
    setState("ready");

    const ctx = ctxRef.current;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (!ctx || !chunks.length) return;

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    const wav = encodeWav(downsample(joined, ctx.sampleRate));
    /* A tap rather than a hold produces a few milliseconds of nothing. Sending
       it would cost a slot against the six-per-minute limit for a clip nobody
       can hear. */
    if (wav.length < 44 + TARGET_SAMPLE_RATE / 4) return;
    send(toBase64(wav));
  }, [send]);

  const startTalking = useCallback(() => {
    if (!ctxRef.current || recordingRef.current) return;
    /* The press is itself a gesture, so this is the one moment resuming is
       always allowed. Belt and braces against a suspension that arrived without
       a visibility change, which iOS does produce. */
    if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
    chunksRef.current = [];
    recordingRef.current = true;
    setState("recording");
    setHeld(0);
    const began = Date.now();
    heldTimerRef.current = setInterval(
      () => setHeld((Date.now() - began) / 1000),
      100,
    );
    /* Hard stop at the cap. Someone who forgets they are holding the button
       sends eight seconds, not a refusal. */
    stopTimerRef.current = setTimeout(
      () => stopTalking(),
      MAX_CLIP_SECONDS * 1000,
    );
  }, [stopTalking]);

  /* Playback. Queued rather than played on arrival, so two clips that land
     together are heard in turn.

     Defined at hook level rather than inside the effect that receives a clip,
     because two other things have to be able to restart a stalled queue: the
     watchdog below, and coming back from the background. */
  const playNext = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    const next = queueRef.current.shift();
    const ctx = ctxRef.current;
    if (!next || !ctx) {
      playingRef.current = false;
      setSpeaking(null);
      return;
    }
    playingRef.current = true;
    setSpeaking(next.from);
    /* `decodeAudioData` wants its own copy: it detaches the buffer it is
       given, and the queued clip may still be needed if decoding fails. */
    const bytes = fromBase64(next.audio);
    ctx
      .decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer)
      .then((buffer) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => playNext();
        source.start();

        /* `onended` is not guaranteed to arrive. iOS can interrupt the audio
           session when the phone locks or a call comes in, which discards the
           source without ever ending it, and the queue then waits on a callback
           that will never fire. Silent, permanent, and indistinguishable from a
           blocked network, which is the worst kind of failure this app can have.

           So: expect the clip to finish, and if it has not, move on. A context
           that is merely paused is not a stall, so that case re-arms instead of
           skipping, and the clip resumes where it left off when the tab does. */
        const arm = (ms: number) => {
          watchdogRef.current = setTimeout(() => {
            if (!playingRef.current) return;
            if (ctxRef.current && ctxRef.current.state !== "running") {
              arm(1000);
              return;
            }
            playNext();
          }, ms);
        };
        arm(buffer.duration * 1000 + 500);
      })
      .catch(() => {
        /* A clip that will not decode is dropped rather than stalling the
           queue behind it. Nothing is retried: it is already spoken. */
        playNext();
      });
  }, []);

  useEffect(() => {
    if (!lastClip || !inVoice) return;
    queueRef.current.push(lastClip);
    if (!playingRef.current) playNext();
  }, [lastClip, inVoice, playNext]);

  /* Coming back from the background.

     iOS suspends an `AudioContext` when the tab is hidden or the phone locks,
     and never resumes it on its own. Everything downstream keeps working: clips
     arrive, decode, and get scheduled onto a context that produces no sound. A
     player who locks their phone once during a puzzle would have had voice go
     silent for the rest of the session with nothing on screen to say so.

     Resuming needs no user gesture here because the context was already
     unlocked by the tap that joined; iOS only requires the gesture for the
     first one. */
  useEffect(() => {
    if (!inVoice) return;
    const wake = () => {
      const ctx = ctxRef.current;
      if (!ctx || document.hidden) return;
      if (ctx.state === "suspended") {
        void ctx.resume().then(
          () => {
            /* Whatever was mid-clip when the tab went away is gone as often as
               not, so a queue that still thinks it is playing gets restarted
               rather than trusted. */
            if (playingRef.current && queueRef.current.length) playNext();
          },
          () => {
            /* A context that will not resume means voice is over for this
               session. Said out loud, because a silent failure here is exactly
               the thing this effect exists to prevent. */
            setState("failed");
          },
        );
      }
    };
    document.addEventListener("visibilitychange", wake);
    /* `focus` as well, because a phone unlocking does not always fire a
       visibility change on iOS. */
    window.addEventListener("focus", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [inVoice, playNext]);

  return {
    state,
    speaking,
    held,
    join: doJoin,
    leave: doLeave,
    startTalking,
    stopTalking,
  };
}
