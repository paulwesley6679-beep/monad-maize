// ---------------------------------------------------------------------------
// useContracts — the app's contract-call layer.
//
// Owns all on-chain reads (oracle price, balances, allowance) and the two
// state-changing flows (mint + redeem), plus the tx lifecycle:
//     idle → approving → minting → success | failed
//     idle →                redeeming → success | failed
// UI components call only these functions; no ethers types leak into them.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, JsonRpcProvider, Signer } from "ethers";

import { COLLATERAL_VAULT_ADDRESS, POLL_INTERVAL_MS } from "../config";
import {
  fmtMUSD,
  fmtMZNGN,
  mockusdContract,
  mzngnContract,
  oracleContract,
  parseMUSD,
  parseMZNGN,
  vaultContract,
} from "../lib/contracts";
import { describeError, type AppError } from "../lib/errors";

export type TxPhase = "idle" | "approving" | "minting" | "redeeming" | "success" | "failed";

export interface OracleState {
  price: bigint | null;
  updatedAt: number | null;
  source: string | null;
  stalenessWindowSec: number | null;
  loading: boolean;
  error: AppError | null;
}

export interface BalanceState {
  musd: bigint | null;
  mzngn: bigint | null;
  mon: bigint | null;
  allowance: bigint | null;
  loading: boolean;
  error: AppError | null;
}

export interface TxState {
  phase: TxPhase;
  txHash: string | null;
  error: AppError | null;
}

export interface PreviewResult {
  /** Raw token units, ready for formatUnits — null when the preview failed. */
  raw: bigint | null;
  /** Human-readable value (formatted directly), or null on failure. */
  text: string | null;
  error: AppError | null;
}

export interface UseContractsArgs {
  account: string | null;
  networkOk: boolean;
  signer: Signer | null;
  walletProvider: BrowserProvider | null;
  publicProvider: JsonRpcProvider;
}

export function useContracts({ account, networkOk, signer, walletProvider, publicProvider }: UseContractsArgs) {
  // Reads go through the wallet provider when connected (same chain state,
  // works even if the public RPC is down), otherwise the public RPC.
  const readRunner = useMemo(
    () => (walletProvider ?? publicProvider) as Parameters<typeof mockusdContract>[0],
    [walletProvider, publicProvider]
  );

  const [oracle, setOracle] = useState<OracleState>({
    price: null,
    updatedAt: null,
    source: null,
    stalenessWindowSec: null,
    loading: true,
    error: null,
  });
  const [balances, setBalances] = useState<BalanceState>({
    musd: null,
    mzngn: null,
    mon: null,
    allowance: null,
    loading: true,
    error: null,
  });
  const [tx, setTx] = useState<TxState>({ phase: "idle", txHash: null, error: null });

  // Keep the latest args in a ref so interval callbacks never go stale.
  const argsRef = useRef({ account, networkOk, signer, walletProvider, publicProvider });
  argsRef.current = { account, networkOk, signer, walletProvider, publicProvider };
  // Mirror balances into a ref so the mint/redeem flows can read the freshest
  // state without adding them to callback dependency arrays.
  const balancesRef = useRef(balances);
  balancesRef.current = balances;

  // ------------------------------------------------------------- oracle read
  const refreshOracle = useCallback(async () => {
    const runner = argsRef.current.walletProvider ?? argsRef.current.publicProvider;
    try {
      const oracle = oracleContract(runner as Parameters<typeof oracleContract>[0]);
      const [price, updatedAt, source] = await oracle.getPrice();
      let staleness: bigint | null = null;
      try {
        staleness = await oracle.stalenessWindow();
      } catch {
        staleness = null;
      }
      setOracle({
        price: price as bigint,
        updatedAt: Number(updatedAt),
        source: source as string,
        stalenessWindowSec: staleness !== null ? Number(staleness) : null,
        loading: false,
        error: null,
      });
    } catch (e) {
      setOracle((prev) => ({ ...prev, loading: false, error: describeError(e) }));
    }
  }, []);

  // ------------------------------------------------------------ balance read
  const refreshBalances = useCallback(async () => {
    const { account, walletProvider, publicProvider } = argsRef.current;
    if (!account) {
      setBalances((prev) => ({
        ...prev,
        loading: false,
        musd: null,
        mzngn: null,
        mon: null,
        allowance: null,
        error: null,
      }));
      return;
    }
    const runner = (walletProvider ?? publicProvider) as Parameters<typeof mockusdContract>[0];
    try {
      const [musd, mzngn, allowance, mon] = await Promise.all([
        mockusdContract(runner).balanceOf(account),
        mzngnContract(runner).balanceOf(account),
        mockusdContract(runner).allowance(account, COLLATERAL_VAULT_ADDRESS),
        publicProvider.getBalance(account),
      ]);
      setBalances({
        musd: musd as bigint,
        mzngn: mzngn as bigint,
        mon: mon as bigint,
        allowance: allowance as bigint,
        loading: false,
        error: null,
      });
    } catch (e) {
      setBalances((prev) => ({ ...prev, loading: false, error: describeError(e) }));
    }
  }, []);

  useEffect(() => {
    refreshOracle();
    const id = setInterval(() => {
      refreshOracle();
      refreshBalances();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refreshOracle, refreshBalances]);

  useEffect(() => {
    refreshBalances();
  }, [account, networkOk, refreshBalances]);

  // ---------------------------------------------------------------- previews
  const previewMint = useCallback(
    async (amountStr: string): Promise<PreviewResult> => {
      if (!amountStr || Number(amountStr) <= 0) {
        return { raw: null, text: null, error: null };
      }
      try {
        const amount = parseMUSD(amountStr);
        const raw = await vaultContract(readRunner).getMintPreview(amount);
        return { raw: raw as bigint, text: fmtMZNGN(raw as bigint), error: null };
      } catch (e) {
        const err = describeError(e);
        return { raw: null, text: null, error: err };
      }
    },
    [readRunner]
  );

  const previewRedeem = useCallback(
    async (amountStr: string): Promise<PreviewResult> => {
      if (!amountStr || Number(amountStr) <= 0) {
        return { raw: null, text: null, error: null };
      }
      try {
        const amount = parseMZNGN(amountStr);
        const raw = await vaultContract(readRunner).getRedeemPreview(amount);
        return { raw: raw as bigint, text: fmtMUSD(raw as bigint), error: null };
      } catch (e) {
        const err = describeError(e);
        return { raw: null, text: null, error: err };
      }
    },
    [readRunner]
  );

  // -------------------------------------------------------------- mint flow
  const mint = useCallback(
    async (amountStr: string) => {
      const { account, networkOk, signer } = argsRef.current;
      if (!networkOk || !account || !signer) {
        setTx({
          phase: "failed",
          txHash: null,
          error: {
            title: "Wallet not connected to Monad Testnet",
            message: "Connect your wallet and switch to Monad Testnet before minting.",
          },
        });
        return;
      }

      setTx({ phase: "idle", txHash: null, error: null });
      let amount: bigint;
      try {
        amount = parseMUSD(amountStr);
        if (amount <= BigInt(0)) throw new Error("Enter an amount of mUSD greater than zero.");
      } catch (e) {
        setTx({ phase: "failed", txHash: null, error: describeError(e) });
        return;
      }

      // Client-side pre-check for a friendlier error before MetaMask pops up
      // (the contract re-checks on-chain regardless).
      const balance = balancesRef.current.musd;
      if (balance !== null && amount > balance) {
        setTx({
          phase: "failed",
          txHash: null,
          error: {
            title: "Not enough mUSD",
            message: `You need ${fmtMUSD(amount)} mUSD but only hold ${fmtMUSD(balance)}.`,
          },
        });
        return;
      }

      try {
        // 1. Approve the vault to pull mUSD when the current allowance is short.
        const allowance = balancesRef.current.allowance;
        const writeSigner = signer;
        if (allowance === null || allowance < amount) {
          setTx({ phase: "approving", txHash: null, error: null });
          const usd = mockusdContract(writeSigner as Parameters<typeof mockusdContract>[0]);
          const apprTx = await usd.approve(COLLATERAL_VAULT_ADDRESS, amount);
          await apprTx.wait();
        }

        // 2. Mint through the vault.
        setTx({ phase: "minting", txHash: null, error: null });
        const vault = vaultContract(writeSigner as Parameters<typeof vaultContract>[0]);
        const mintTx = await vault.mint(amount);
        const receipt = await mintTx.wait();
        setTx({ phase: "success", txHash: receipt.hash, error: null });
        refreshBalances();
      } catch (e) {
        setTx({ phase: "failed", txHash: null, error: describeError(e) });
      }
    },
    [refreshBalances]
  );

  // ------------------------------------------------------------ redeem flow
  const redeem = useCallback(
    async (amountStr: string) => {
      const { account, networkOk, signer } = argsRef.current;
      if (!networkOk || !account || !signer) {
        setTx({
          phase: "failed",
          txHash: null,
          error: {
            title: "Wallet not connected to Monad Testnet",
            message: "Connect your wallet and switch to Monad Testnet before redeeming.",
          },
        });
        return;
      }

      setTx({ phase: "idle", txHash: null, error: null });
      let amount: bigint;
      try {
        amount = parseMZNGN(amountStr);
        if (amount <= BigInt(0)) throw new Error("Enter an amount of mzNGN greater than zero.");
      } catch (e) {
        setTx({ phase: "failed", txHash: null, error: describeError(e) });
        return;
      }

      const held = balancesRef.current.mzngn;
      if (held !== null && amount > held) {
        setTx({
          phase: "failed",
          txHash: null,
          error: {
            title: "Not enough mzNGN",
            message: `You tried to redeem ${fmtMZNGN(amount)} mzNGN but only hold ${fmtMZNGN(held)}.`,
          },
        });
        return;
      }

      try {
        setTx({ phase: "redeeming", txHash: null, error: null });
        const vault = vaultContract(signer as Parameters<typeof vaultContract>[0]);
        const redeemTx = await vault.redeem(amount);
        const receipt = await redeemTx.wait();
        setTx({ phase: "success", txHash: receipt.hash, error: null });
        refreshBalances();
      } catch (e) {
        setTx({ phase: "failed", txHash: null, error: describeError(e) });
      }
    },
    [refreshBalances]
  );

  const resetTx = useCallback(() => setTx({ phase: "idle", txHash: null, error: null }), []);

  return {
    oracle,
    balances,
    tx,
    refreshOracle,
    refreshBalances,
    resetTx,
    mint,
    redeem,
    previewMint,
    previewRedeem,
  };
}