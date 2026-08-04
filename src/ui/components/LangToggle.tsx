/* One button, always naming the other language in that language. The reader
   who needs it most is the one who cannot read the current one, so the label
   is never translated. */

import { setLang, useLang } from "../i18n/index.ts";

export function LangToggle() {
  const current = useLang();
  const other = current === "fa" ? "en" : "fa";
  return (
    /* No `dir` attribute: logical inset properties resolve against the
       element's own direction, so a dir here would move the button to the
       opposite corner from the one the page's direction chose. */
    <button
      type="button"
      class="lang-toggle"
      lang={other}
      onClick={() => setLang(other)}
    >
      {other === "fa" ? "فارسی" : "English"}
    </button>
  );
}
