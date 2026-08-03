/* Entry point. Three routes, no framework beyond Preact, no router dependency.
   See ADR-10 and its 2026-08-03 amendment. */

import { render } from "preact";
import "./styles.css";
import { useRoute } from "./lib/router.ts";
import { Landing } from "./routes/Landing.tsx";
import { New } from "./routes/New.tsx";
import { Play } from "./routes/Play.tsx";

function App() {
  const route = useRoute();
  switch (route.name) {
    case "landing":
      return <Landing />;
    case "new":
      return <New />;
    case "play":
      return <Play id={route.id} />;
    default:
      return (
        <main>
          <h1>Nothing here</h1>
          <p class="lede">That address does not match a puzzle.</p>
          <a class="button" href="/">
            Back
          </a>
        </main>
      );
  }
}

const root = document.querySelector("#app");
if (root) render(<App />, root);
