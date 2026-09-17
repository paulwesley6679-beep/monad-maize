// ---------------------------------------------------------------------------
// OraclePanel — current maize reference price from the deployed PriceOracle.
// Works even before a wallet is connected (public reads).
// ---------------------------------------------------------------------------

import React from "react";
import type { OracleState } from "../hooks/useContracts";
import { fmtPrice, fmtTimestamp } from "../lib/contracts";

interface Props {
  oracle: OracleState;
}

export const OraclePanel: React.FC<Props> = ({ oracle }) => {
  const staleAgo = (() => {
    if (oracle.price === null || oracle.updatedAt === null || oracle.stalenessWindowSec === null) return null;
    const ageSec = Math.floor(Date.now() / 1000) - oracle.updatedAt;
    // Clamp at 0: browser clock can drift ahead of the chain's block timestamp,
    // which would otherwise show a silly negative "window used" percentage.
    const pct = Math.max(0, (ageSec / oracle.stalenessWindowSec) * 100);
    return { ageSec, pct };
  })();

  return (
    <section className="card">
      <div className="card-title">
        🌽 Maize reference price{" "}
        <span className="muted">(per 100 kg bag, from PriceOracle)</span>
      </div>

      {oracle.loading && oracle.price === null ? (
        <p className="muted">Loading price…</p>
      ) : oracle.error ? (
        <div className="banner banner-error">
          <strong>{oracle.error.title}</strong>
          <p>{oracle.error.message}</p>
        </div>
      ) : (
        <>
          <div className="price-row">
            <span className="price-big">
              {fmtPrice(oracle.price)} <span className="muted">mUSD</span>
            </span>
          </div>
          <dl className="kv">
            <div>
              <dt>Last updated</dt>
              <dd>{fmtTimestamp(oracle.updatedAt)}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{oracle.source ?? "—"}</dd>
            </div>
            <div>
              <dt>Freshness window</dt>
              <dd>
                {oracle.stalenessWindowSec !== null
                  ? `${Math.round(oracle.stalenessWindowSec / 3600)} h`
                  : "—"}
                {staleAgo !== null && (
                  <span className="muted">
                    {" "}
                    · refresh cadence: every 10 s ({staleAgo.pct.toFixed(0)}% of window used)
                  </span>
                )}
              </dd>
            </div>
          </dl>
          <p className="note muted">
            Minting and redeeming pause automatically if this price goes stale
            (contract enforces it on every read).
          </p>
        </>
      )}
    </section>
  );
};