/* A way out of every screen.

   Every route was a dead end unless it happened to offer a button, so the only
   reliable way home was editing the address bar. That is fine on a laptop and
   not fine on a phone, where the browser chrome is hidden while scrolling.

   Deliberately not a full navigation bar. This app has four screens and no
   hierarchy worth drawing; what it needs is "back" and "home", and anything
   more would be furniture. */

import { navigate } from "../lib/router.ts";
import { useT } from "../i18n/index.ts";

export function Crumbs({ label }: { label?: string }) {
  const t = useT();
  return (
    <nav class="crumbs" aria-label={t.common.navLabel}>
      <button
        type="button"
        class="crumb"
        onClick={() => {
          /* `history.back()` when there is somewhere to go back to, and home
             otherwise. A shared link opened cold has no history, and a back
             button that does nothing is worse than one that is not there. */
          if (history.length > 1) history.back();
          else navigate("/");
        }}
      >
        {t.common.back}
      </button>
      <button type="button" class="crumb" onClick={() => navigate("/")}>
        {t.common.home}
      </button>
      {label && <span class="crumb-label">{label}</span>}
    </nav>
  );
}
