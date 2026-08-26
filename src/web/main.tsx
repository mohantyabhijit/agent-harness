import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "@truefoundry/trueforge-ui/styles.css";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) throw new Error("OpenQuest root element is missing");

createRoot(rootElement).render(<StrictMode><App /></StrictMode>);
