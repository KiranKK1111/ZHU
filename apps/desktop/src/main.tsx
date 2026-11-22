import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/app/providers/AppProviders";
import { windowKind } from "@/services/shell";
import "@/styles/globals.css";

// One bundle, two window roots. Each window loads only its own root.
const ROOTS = {
  main: lazy(() => import("@/app/windows/MainApp")),
  bubble: lazy(() => import("@/app/windows/BubbleApp")),
};

const kind = windowKind();
const Root = ROOTS[kind];
document.documentElement.dataset.window = kind;
// The floating icon draws only itself: no window background, not even before it renders.
if (kind === "bubble") document.documentElement.classList.add("zhu-transparent");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders toasts={kind !== "bubble"}>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </AppProviders>
  </StrictMode>,
);
