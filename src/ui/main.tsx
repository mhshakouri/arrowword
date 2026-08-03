/* Entry point. Three routes, no framework beyond Preact, no router dependency.
   See ADR-10 and its 2026-08-03 amendment. */

import { render } from "preact";
import "./styles.css";
import { useRoute } from "./lib/router.ts";
import { Landing } from "./routes/Landing.tsx";
import { New } from "./routes/New.tsx";

function App() {
  const route = useRoute();
  switch (route.name) {
    case "landing":
      return <Landing />;
    case "new":
      return <New />;
    case "play":
      /* A3 builds this. Until then the route resolves rather than 404s, so a
         share link is not broken while the play screen is unbuilt. */
      return (
        <main>
          <h1>Not built yet</h1>
          <p class="lede">
            The play screen arrives with milestone A3. This link will work then.
          </p>
          <a class="button" href="/">
            Back
          </a>
        </main>
      );
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
