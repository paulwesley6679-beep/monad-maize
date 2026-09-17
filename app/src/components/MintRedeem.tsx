// ---------------------------------------------------------------------------
// MintRedeem — the two user flows:
//   Mint   : deposit mUSD  → preview mzNGN received (150% collateral math)
//   Redeem : burn mzNGN    → preview mUSD paid out
// Both show a live preview as you type (via the vault's get*Preview view
// functions), then a confirm button that executes the real transaction and
// surfaces success/failure with an explorer link.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { BalanceState, PreviewResult, TxState } from "../hooks/useContracts";
import { EXPLORER_TX, MIN_COLLATERAL_MUSD, MZNGN_SYMBOL, MOCKUSD_SYMBOL } from "../config";
import { fmtMUSD, fmtMZNGN } from "../lib/contracts";

type Mode = "mint" | "redeem";

interface Props {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  connected: boolean;
  networkOk: boolean;
  balances: BalanceState;
  tx: TxState;
  onMint: (amount: string) => Promise<void>;
  onRedeem: (amount: string) => Promise<void>;
  previewMint: (amount: string) => Promise<PreviewResult>;
  previewRedeem: (amount: string) => Promise<PreviewResult>;
  onDone: () => void;
}

export const MintRedeem: React.FC<Props> = ({
  mode,
  onModeChange,
  connected,
  networkOk,
  balances,
  tx,
  onMint,
  onRedeem,
  previewMint,
  previewRedeem,
  onDone,
}) => {
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<PreviewResult>({ raw: null, text: null, error: null });
  const [previewing, setPreviewing] = useState(false);
  const amountRef = useRef(amount);
  amountRef.current = amount;

  const busy =
    tx.phase === "approving" || tx.phase === "minting" || tx.phase === "redeeming";

  const canSubmit =
    networkOk &&
    connected &&
    !busy &&
    amount.trim() !== "" &&
    Number(amount) > 0 &&
    tx.phase !== "success";

  // --- live preview (debounced ~400ms) -------------------------------------
  useEffect(() => {
    if (!amount.trim() || Number(amount) <= 0) {
      setPreview({ raw: null, text: null, error: null });
      return;
    }
    setPreviewing(true);
    const id = setTimeout(async () => {
      const res =
        mode === "mint" ? await previewMint(amountRef.current) : await previewRedeem(amountRef.current);
      setPreview(res);
      setPreviewing(false);
    }, 400);
    return () => clearTimeout(id);
  }, [amount, mode, previewMint, previewRedeem]);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    if (mode === "mint") await onMint(amountRef.current);
    else await onRedeem(amountRef.current);
  }, [canSubmit, mode, onMint, onRedeem]);

  // --- balance sanity warnings ----------------------------------------------
  const amountNum = Number(amount);
  const tooMuch = (() => {
    if (!connected || !amountNum) return null;
    if (mode === "mint" && balances.musd !== null && amountNum > Number(balances.musd) / 1e6) {
      return { line: "You don't have enough mUSD for this mint.", musd: true };
    }
    if (mode === "redeem" && balances.mzngn !== null && amountNum > Number(balances.mzngn) / 1e18) {
      return { line: "You don't hold enough mzNGN for this redeem.", musd: false };
    }
    return null;
  })();

  const belowMin = mode === "mint" && amountNum > 0 && amountNum < Number(MIN_COLLATERAL_MUSD);

  const previewLabel = mode === "mint"
    ? `You'll receive ${fmtMZNGN(preview.raw)} ${MZNGN_SYMBOL}`
    : `You'll receive ${fmtMUSD(preview.raw)} ${MOCKUSD_SYMBOL}`;

  const inputLabel = mode === "mint"
    ? `Deposit ${MOCKUSD_SYMBOL} (collateral)`
    : `Burn ${MZNGN_SYMBOL} (maize tokens)`;

  return (
    <section className="card">
      <div className="card-title">Mint / Redeem</div>

      <div className="tabs">
        <button className={`tab ${mode === "mint" ? "tab-active" : ""}`} onClick={() => onModeChange("mint")}>
          Mint {MZNGN_SYMBOL}
        </button>
        <button className={`tab ${mode === "redeem" ? "tab-active" : ""}`} onClick={() => onModeChange("redeem")}>
          Redeem {MZNGN_SYMBOL}
        </button>
      </div>

      {!connected ? (
        <p className="muted">Connect your wallet first — minting and redeeming need a signer.</p>
      ) : !networkOk ? (
        <p className="muted">
          Mint/redeem is disabled until you're on Monad Testnet (see the wallet
          panel above to switch).
        </p>
      ) : (
        <>
          <div className="form-row">
            <label>
              {inputLabel}
              <input
                type="number"
                step={mode === "mint" ? "0.01" : "0.0001"}
                min="0"
                value={amount}
                placeholder={mode === "mint" ? "e.g. 150.00" : "e.g. 1.0000"}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
              />
            </label>

            {belowMin && (
              <p className="warn">
                The vault requires at least {MIN_COLLATERAL_MUSD} {MOCKUSD_SYMBOL} per mint.
              </p>
            )}
            {tooMuch && <p className="warn">{tooMuch.line}</p>}

            {previewing ? (
              <p className="muted">Previewing…</p>
            ) : preview.error ? (
              <p className="warn">
                <strong>{preview.error.title}:</strong> {preview.error.message}
              </p>
            ) : (
              <p className={`preview ${preview.text ? "preview-has" : ""}`}>{previewLabel}</p>
            )}
          </div>

          <p className="note muted">
            {mode === "mint"
              ? "The vault keeps a 150% collateral buffer: a 150.00 mUSD deposit at a 50.00 mUSD/bag price mints 2.00 mzNGN."
              : "Redeeming pays out at the 150% ratio: burning 1.00 mzNGN at a 50.00 mUSD/bag price returns 75.00 mUSD."}
          </p>

          <div className="form-row">
            <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
              {busy
                ? tx.phase === "approving"
                  ? "Approving mUSD…"
                  : tx.phase === "minting"
                    ? "Confirming mint…"
                    : "Confirming redeem…"
                : mode === "mint"
                  ? `Mint ${MZNGN_SYMBOL}`
                  : `Redeem ${MZNGN_SYMBOL}`}
            </button>
          </div>
        </>
      )}

      {/* ---- transaction status ---- */}
      {tx.phase === "success" && tx.txHash && (
        <div className="banner banner-ok">
          <div>
            <strong>Transaction confirmed</strong>
            <p>
              {mode === "mint" ? "mzNGN minted" : "mUSD paid out"} — balances above are being refreshed.
            </p>
            <a className="link" href={EXPLORER_TX(tx.txHash)} target="_blank" rel="noopener noreferrer">
              View on MonadVision → {tx.txHash.slice(0, 10)}…
            </a>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onDone}>
            Done
          </button>
        </div>
      )}

      {tx.phase === "failed" && tx.error && (
        <div className="banner banner-error">
          <div>
            <strong>{tx.error.title}</strong>
            <p>{tx.error.message}</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onDone}>
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
};