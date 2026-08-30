import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "@truefoundry/trueforge-ui/styles.css";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) throw new Error("OpenQuest root element is missing");

// TrueForge owns an external-store runtime that is not StrictMode-safe in its
// current release. Keep one production-equivalent mount until that upstream
// lifecycle bug is resolved.
createRoot(rootElement).render(<App />);
