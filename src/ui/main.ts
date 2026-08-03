/* Entry point. A1 builds the landing page, the photo step, and the alignment
   step on top of this; for now it exists so the build produces a real bundle
   and the asset routing can be verified end to end.

   No UI framework is chosen yet: ADR-10 settled on Vite and left what runs
   inside it open, which is a dependency decision under section 15 trigger 3. */

const app = document.querySelector<HTMLDivElement>("#app");
if (app) {
  app.textContent = "Arrowword Co-op";
}
