import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import ActivationScreen from "./screens/ActivationScreen";

// StrictMode intentionally disabled: it double-mounts components in dev,
// which would spawn two Gemini Live sessions and tangle audio streams.

function Root() {
  // 'checking' renders nothing so we don't flash the activation gate when the
  // Keychain already has a valid key.
  const [state, setState] = useState<"checking" | "needs-key" | "ready">("checking");

  useEffect(() => {
    invoke<boolean>("activation_has_valid_key")
      .then((ok) => setState(ok ? "ready" : "needs-key"))
      .catch(() => setState("needs-key"));
  }, []);

  if (state === "checking") return null;
  if (state === "needs-key") return <ActivationScreen onActivated={() => setState("ready")} />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
