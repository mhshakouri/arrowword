/* The share link, shown prominently after saving. Spec section 10 step 5.

   This link is the only credential (ADR-2), so it is worth saying so where
   someone is about to paste it somewhere. */

import { useState } from "preact/hooks";
import { useT } from "../i18n/index.ts";

export interface ShareLinkProps {
  id: string;
  /* Whether to offer a way into the puzzle. False when the reader is already
     looking at it: after saving, "open the puzzle" is the next thing anyone
     wants, and mid-solve it is an invitation to a room you are standing in. */
  showOpen?: boolean;
}

export function ShareLink({ id, showOpen = true }: ShareLinkProps) {
  const t = useT();
  const url = `${location.origin}/s/${id}`;
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    setFailed(false);
    try {
      /* Absent on http origins other than localhost, and blocked when the page
         is not the active tab, so a failure here is ordinary rather than
         exceptional. */
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div class="card stack">
      <div>
        <label for="share">{t.share.label}</label>
        <input
          id="share"
          type="text"
          readOnly
          dir="ltr"
          value={url}
          /* Selecting on focus is the fallback when the clipboard is
             unavailable: the reader can still copy it by hand. */
          onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
        />
      </div>
      <div class="row">
        <button class="primary" onClick={() => void copy()}>
          {copied ? t.share.copied : t.share.copy}
        </button>
        {showOpen && (
          <a class="button" href={`/s/${id}`}>
            {t.share.openPuzzle}
          </a>
        )}
      </div>
      {failed && (
        <p class="muted" role="status" style="margin:0">
          {t.share.copyBlocked}
        </p>
      )}
      <p class="muted" style="margin:0">
        {t.share.keyNote}
      </p>
    </div>
  );
}
