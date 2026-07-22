import { createRoot } from "react-dom/client";
import App from "./App";
import "./globals.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

// Note: intentionally not wrapped in <StrictMode>. The WebGL renderer
// setup/teardown doesn't tolerate effect double-invocation.
createRoot(rootElement).render(<App />);
