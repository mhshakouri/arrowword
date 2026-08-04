/* The voice room on the play screen. C1, spec section 12.

   Deliberately below the grid rather than above it. The puzzle is why anyone is
   here, and a talk button that pushes the board down the page costs every
   solver something to benefit the few who use it. */

import type { PeerInfo, VoicePeer } from "../../types";
import { playerId } from "../lib/local.ts";
import { useVoice, type IncomingClip, voiceSupported } from "../lib/voice.ts";
import { useT } from "../i18n/index.ts";

const MAX_CLIP_SECONDS = 8;

export function PushToTalk({
  peers,
  voicePeers,
  lastClip,
  onJoin,
  onLeave,
  onClip,
}: {
  peers: PeerInfo[];
  voicePeers: VoicePeer[];
  lastClip: IncomingClip | null;
  onJoin: () => void;
  onLeave: () => void;
  onClip: (audio: string) => void;
}) {
  const t = useT();
  const me = playerId();
  const inVoice = voicePeers.some((p) => p.id === me);
  const voice = useVoice(inVoice, lastClip, onClip, onJoin, onLeave);

  /* Nicknames live in the session's peer list, not in the voice room, so the
     two are joined here. A voice peer with no matching nickname is someone who
     joined voice in the instant before their `peers` update arrived. */
  const nameOf = (id: string) =>
    peers.find((p) => p.id === id)?.nickname ?? t.voice.someone;
  const colorOf = (id: string) => peers.find((p) => p.id === id)?.color ?? 0;

  if (voice.state === "unsupported" || !voiceSupported()) {
    return (
      <p class="muted" style="margin-top:1rem">
        {t.voice.unsupported}
      </p>
    );
  }

  if (voice.state === "off" || voice.state === "joining") {
    return (
      <div style="margin-top:1rem">
        <button
          disabled={voice.state === "joining"}
          onClick={voice.join}
          aria-label={t.voice.join}
        >
          {voice.state === "joining" ? t.voice.asking : t.voice.join}
        </button>
        <p class="muted" style="margin-top:0.5rem;margin-bottom:0">
          {t.voice.joinNote}
        </p>
      </div>
    );
  }

  if (voice.state === "denied") {
    return (
      <p class="notice error" role="alert" style="margin-top:1rem">
        {t.voice.denied}
      </p>
    );
  }

  if (voice.state === "failed") {
    return (
      <div class="notice error" role="alert" style="margin-top:1rem">
        <p style="margin:0 0 0.5rem">{t.voice.micFailed}</p>
        <button onClick={voice.join}>{t.voice.tryAgain}</button>
      </div>
    );
  }

  const others = voicePeers.filter((p) => p.id !== me);
  const recording = voice.state === "recording";

  return (
    <div class="card stack" style="margin-top:1rem">
      <div class="row">
        {others.length === 0 ? (
          <span class="muted">{t.voice.justYou}</span>
        ) : (
          others.map((p) => (
            <span
              key={p.id}
              class="peer"
              style={`--peer-color: var(--player-${colorOf(p.id) % 10})`}
            >
              {nameOf(p.id)}
              {voice.speaking === p.id && t.voice.speaking}
            </span>
          ))
        )}
      </div>

      <button
        class={recording ? "primary" : ""}
        /* Pointer events cover mouse and touch in one path. `touch-action:none`
           stops the hold turning into a page scroll on a phone, which was the
           whole gesture being swallowed. */
        style="touch-action:none;user-select:none"
        onPointerDown={voice.startTalking}
        onPointerUp={voice.stopTalking}
        /* Leaving the button or losing the pointer both end the clip. Without
           these a finger sliding off mid-sentence records until the eight
           second cap and sends the lot. */
        onPointerLeave={voice.stopTalking}
        onPointerCancel={voice.stopTalking}
        aria-label={recording ? t.voice.releaseLabel : t.voice.holdLabel}
      >
        {recording
          ? t.voice.releaseToSend(
              Number(Math.max(0, MAX_CLIP_SECONDS - voice.held).toFixed(0)),
            )
          : t.voice.holdToTalk}
      </button>

      <div class="row">
        <button onClick={voice.leave}>{t.voice.leave}</button>
        <span class="muted">
          {recording
            ? t.voice.recordingNote
            : t.voice.capNote(MAX_CLIP_SECONDS)}
        </span>
      </div>
    </div>
  );
}
