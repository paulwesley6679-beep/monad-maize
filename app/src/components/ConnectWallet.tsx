// ---------------------------------------------------------------------------
// ConnectWallet — the top-bar wallet connect button and network status.
// ---------------------------------------------------------------------------

import React from "react";
import type { WalletStatus } from "../hooks/useWallet";
import type { AppError } from "../lib/errors";
import { EXPLORER_URL, CHAIN_NAME, CHAIN_ID } from "../config";

function truncateAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

interface Props {
  status: WalletStatus;
  account: string | null;
  chainId: number | null;
  error: AppError | null;
  onConnect: () => void;
  onSwitch: () => void;
  onDisconnect: () => void;
  clearError: () => void;
}

export const ConnectWallet: React.FC<Props> = ({
  status,
  account,
  chainId,
  error,
  onConnect,
  onSwitch,
  onDisconnect,
  clearError,
}) => {
  return (
    <section className="card connect-card">
      {error && (
        <div className="banner banner-error">
          <div>
            <strong>{error.title}</strong>
            <p>{error.message}</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={clearError} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      <div className="connect-row">
        {/* Always show the connect/reconnect button */}
        {status === "disconnected" && (
          <button className="btn btn-primary" onClick={onConnect}>
            Connect wallet
          </button>
        )}

        {status === "connecting" && (
          <span className="muted">Waiting for MetaMask…</span>
        )}

        {status === "wrong-network" && (
          <>
            <span className="badge badge-warn">
              On chain {chainId} — need {CHAIN_NAME} ({CHAIN_ID})
            </span>
            <button className="btn btn-primary" onClick={onSwitch}>
              Switch to {CHAIN_NAME}
            </button>
          </>
        )}

        {status === "connected" && account && (
          <>
            <a
              className="link addr"
              href={`${EXPLORER_URL}/address/${account}`}
              target="_blank"
              rel="noopener noreferrer"
              title={account}
            >
              {truncateAddr(account)}
            </a>
            <span className="badge badge-ok">Monad Testnet</span>
            <button className="btn btn-ghost btn-sm" onClick={onDisconnect}>
              Disconnect
            </button>
          </>
        )}
      </div>
    </section>
  );
};