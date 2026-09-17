// ---------------------------------------------------------------------------
// BalancePanel — the connected wallet's mUSD / mzNGN / MON balances plus the
// current vault allowance. Updates live (polled every 10s and after every tx).
// ---------------------------------------------------------------------------

import React from "react";
import type { BalanceState } from "../hooks/useContracts";
import { fmtMUSD, fmtMZNGN } from "../lib/contracts";

interface Props {
  balances: BalanceState;
  connected: boolean;
}

export const BalancePanel: React.FC<Props> = ({ balances, connected }) => {
  return (
    <section className="card">
      <div className="card-title">Balances</div>

      {!connected ? (
        <p className="muted">
          Connect your wallet to see your mUSD and mzNGN balances here.
        </p>
      ) : balances.error ? (
        <div className="banner banner-error">
          <strong>{balances.error.title}</strong>
          <p>{balances.error.message}</p>
        </div>
      ) : balances.loading && balances.musd === null ? (
        <p className="muted">Loading balances…</p>
      ) : (
        <>
          <dl className="kv">
            <div>
              <dt>mUSD collateral</dt>
              <dd>{fmtMUSD(balances.musd)} mUSD</dd>
            </div>
            <div>
              <dt>mzNGN maize tokens</dt>
              <dd>{fmtMZNGN(balances.mzngn)} mzNGN</dd>
            </div>
            <div>
              <dt>MON (gas)</dt>
              <dd>{balances.mon !== null ? Number(balances.mon) / 1e18 : "—"} MON</dd>
            </div>
            <div>
              <dt>Vault allowance</dt>
              <dd>{fmtMUSD(balances.allowance)} mUSD</dd>
            </div>
          </dl>
          <p className="note muted">
            The vault can pull up to your allowance during minting. If it's too
            low, the mint flow asks for a fresh approval first — all in one go.
          </p>
        </>
      )}
    </section>
  );
};