/* Entry point. Four routes, no framework beyond Preact, no router dependency.
   See ADR-10 and its 2026-08-03 amendment. */

import { render } from "preact";
import "./styles.css";
import { useRoute } from "./lib/router.ts";
import { useT } from "./i18n/index.ts";
import { LangToggle } from "./components/LangToggle.tsx";
import { Landing } from "./routes/Landing.tsx";
import { New } from "./routes/New.tsx";
import { Generate } from "./routes/Generate.tsx";
import { Play } from "./routes/Play.tsx";

function Route() {
  const route = useRoute();
  const t = useT();
  switch (route.name) {
    case "landing":
      return <Landing />;
    case "new":
      return <New />;
    case "generate":
      return <Generate />;
    case "play":
      return <Play id={route.id} />;
    default:
      return (
        <main>
          <h1>{t.notFound.title}</h1>
          <p class="lede">{t.notFound.lede}</p>
          <a class="button" href="/">
            {t.common.back}
          </a>
        </main>
      );
  }
}

function App() {
  return (
    <>
      <LangToggle />
      <Route />
    </>
  );
}

const root = document.querySelector("#app");
if (root) render(<App />, root);
