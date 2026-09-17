import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installDevWallet, isDevWalletEnabled } from "./devwallet";
import "./index.css";

// DEV-only testing aid (see devwallet.ts). Activated by ?dev-wallet=1.
if (isDevWalletEnabled()) {
  installDevWallet();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);