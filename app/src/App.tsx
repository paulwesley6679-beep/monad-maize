import React, { useEffect, useMemo, useState } from "react";
import { Signer } from "ethers";

import { useWallet } from "./hooks/useWallet";
import { useContracts } from "./hooks/useContracts";

import { ConnectWallet } from "./components/ConnectWallet";
import { OraclePanel } from "./components/OraclePanel";
import { BalancePanel } from "./components/BalancePanel";
import { MintRedeem } from "./components/MintRedeem";

import { EXPLORER_URL, CHAIN_NAME } from "./config";

export default function App() {
  const wallet = useWallet();
  const { status, account, chainId, browserProvider, publicProvider, error } = wallet;

  const connected = status === "connected";
  const networkOk = connected;

  // The signer is only needed when connected on the right chain; getting it is
  // async in ethers v6, so resolve it in an effect.
  const [signer, setSigner] = useState<Signer | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (networkOk && browserProvider) {
      browserProvider
        .getSigner()
        .then((s) => {
          if (!cancelled) setSigner(s);
        })
        .catch(() => {
          if (!cancelled) setSigner(null);
        });
    } else {
      setSigner(null);
    }
    return () => {
      cancelled = true;
    };
  }, [networkOk, browserProvider]);

  const contracts = useContracts({
    account,
    networkOk,
    signer,
    walletProvider: browserProvider,
    publicProvider,
  });

  const [tab, setTab] = useState<"mint" | "redeem">("mint");

  const explorerLink = useMemo(
    () => (account ? `${EXPLORER_URL}/address/${account}` : undefined),
    [account]
  );

  return (
    <div className="page">
      <header className="header">
        <div className="header-left">
          <h1>🌽 Monad Maize</h1>
          <p className="subtitle">
            {CHAIN_NAME} · testnet only · mzNGN = maize-pegged token backed 150% by mUSD
          </p>
        </div>
        <ConnectWallet
          status={status}
          account={account}
          chainId={chainId}
          error={error}
          onConnect={wallet.connect}
          onSwitch={wallet.switchToMonad}
          onDisconnect={wallet.disconnect}
          clearError={wallet.clearError}
        />
      </header>

      {connected && explorerLink && (
        <p className="account-line muted">
          Connected as{" "}
          <a className="link" href={explorerLink} target="_blank" rel="noopener noreferrer">
            {account}
          </a>
        </p>
      )}

      {/* ---- connection gates ---- */}
      {status === "disconnected" && (
        <div className="banner banner-info">
          <strong>Connect a wallet to get started</strong>
          <p>
            You can still see the live maize price below. Balances, minting and
            redeeming need a MetaMask wallet on Monad Testnet.
          </p>
        </div>
      )}
      {status === "wrong-network" && (
        <div className="banner banner-warn">
          <strong>Wrong network</strong>
          <p>
            You're connected on chain {chainId}, but this app needs{" "}
            {CHAIN_NAME} (chain 10143). Use the “Switch to Monad Testnet” button
            above, or tap the network pill in MetaMask.
          </p>
        </div>
      )}

      <div className="grid">
        <OraclePanel oracle={contracts.oracle} />

        <BalancePanel balances={contracts.balances} connected={connected} />

        <MintRedeem
          mode={tab}
          onModeChange={setTab}
          connected={connected}
          networkOk={networkOk}
          balances={contracts.balances}
          tx={contracts.tx}
          onMint={contracts.mint}
          onRedeem={contracts.redeem}
          previewMint={contracts.previewMint}
          previewRedeem={contracts.previewRedeem}
          onDone={contracts.resetTx}
        />
      </div>

      <footer className="muted">
        mzNGN v0.1 — hackathon MVP. No guarantees. Testnet only, funds are
        worthless play-money. Explorer:{" "}
        <a className="link" href={EXPLORER_URL} target="_blank" rel="noopener noreferrer">
          {EXPLORER_URL}
        </a>
      </footer>
    </div>
  );
}