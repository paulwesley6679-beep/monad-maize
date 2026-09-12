// ---------------------------------------------------------------------------
// useWallet — MetaMask (EIP-1193) connection + Monad Testnet enforcement.
//
// Handles: connecting, prompting a network switch to Monad Testnet (10143),
// adding the network when the wallet doesn't know it, reacting to account/
// chain changes, and exposing a clean status for the UI:
//   "disconnected" | "connecting" | "connected" | "wrong-network"
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, JsonRpcProvider } from "ethers";

import {
  CHAIN_ID,
  MONAD_TESTNET_PARAMS,
  RPC_URL,
} from "../config";
import { describeError, type AppError } from "../lib/errors";

export type WalletStatus = "disconnected" | "connecting" | "connected" | "wrong-network";

export interface MinimalEip1193 {
  isMetaMask?: boolean;
  chainId?: string;
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, cb: (...args: any[]) => unknown): void;
  removeListener?(event: string, cb: (...args: any[]) => unknown): void;
}

declare global {
  interface Window {
    ethereum?: MinimalEip1193;
  }
}

const hasWindowEthereum = (): MinimalEip1193 | undefined =>
  typeof window !== "undefined" ? window.ethereum : undefined;

export function useWallet() {
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [browserProvider, setBrowserProvider] = useState<BrowserProvider | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const ethereum = useMemo<MinimalEip1193 | undefined>(() => hasWindowEthereum(), []);

  const accountRef = useRef<string | null>(null);
  accountRef.current = account;

  // Sent when the user asked for a connection but the wallet is missing.
  const noWalletError = (): AppError => ({
    title: "MetaMask not detected",
    message:
      "Install the MetaMask browser extension, reload this page, then click “Connect wallet”.",
  });

  /** Re-derive our status from the current provider + chain id. */
  const evaluateNetwork = useCallback(
    async (etht: MinimalEip1193): Promise<number | null> => {
      try {
        const hex = await etht.request({ method: "eth_chainId" });
        const id = parseInt(String(hex), 16);
        setChainId(id);
        return id;
      } catch {
        setChainId(null);
        return null;
      }
    },
    []
  );

  /**
   * Prompt MetaMask to switch to Monad Testnet, adding the network first if it
   * doesn't know it. Returns true once we're on 10143.
   */
  const switchChain = useCallback(
    async (etht: MinimalEip1193): Promise<boolean> => {
      try {
        await etht.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: MONAD_TESTNET_PARAMS.chainId }],
        });
        return (await evaluateNetwork(etht)) === CHAIN_ID;
      } catch (err) {
        const e = err as { code?: number };
        if (e?.code === 4902) {
          // Chain not in the wallet yet — add it, then switch.
          try {
            await etht.request({
              method: "wallet_addEthereumChain",
              params: [MONAD_TESTNET_PARAMS],
            });
            await etht.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: MONAD_TESTNET_PARAMS.chainId }],
            });
            return (await evaluateNetwork(etht)) === CHAIN_ID;
          } catch (err2) {
            setError(describeError(err2));
            return false;
          }
        }
        setError(describeError(e));
        return false;
      }
    },
    [evaluateNetwork]
  );

  /** Apply the right status based on whether we have an account + right chain. */
  const applyStatus = useCallback(
    (acc: string | null, chain: number | null): void => {
      if (!acc) {
        setStatus("disconnected");
      } else if (chain === CHAIN_ID) {
        setStatus("connected");
      } else {
        setStatus("wrong-network");
      }
    },
    []
  );

  /** (Re)build signer-capable provider + signer once connected on the right chain. */
  const connectProvider = useCallback(async () => {
    const etht = hasWindowEthereum();
    if (!etht) return;
    const provider = new BrowserProvider(etht);
    setBrowserProvider(provider);
  }, []);

  /** Public read provider (independent of the wallet). */
  const publicProvider = useMemo(() => new JsonRpcProvider(RPC_URL), []);

  const connect = useCallback(async () => {
    const etht = hasWindowEthereum();
    if (!etht) {
      setStatus("disconnected");
      setError(noWalletError());
      return;
    }
    setError(null);
    setStatus("connecting");
    try {
      const accounts = (await etht.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (!accounts?.length) {
        setStatus("disconnected");
        setError({
          title: "No account to connect",
          message: "MetaMask didn't return an account. Unlock it and try again.",
        });
        return;
      }
      const acc = accounts[0].toLowerCase();
      const chain = await evaluateNetwork(etht);
      if (chain !== CHAIN_ID) {
        // Auto-prompt the network switch (MetaMask handles add-if-needed).
        setStatus("wrong-network");
        const switched = await switchChain(etht);
        const finalChain = await evaluateNetwork(etht);
        setAccount(acc);
        if (switched && finalChain === CHAIN_ID) {
          await connectProvider();
          applyStatus(acc, finalChain);
        } else {
          applyStatus(acc, finalChain);
        }
      } else {
        setAccount(acc);
        await connectProvider();
        applyStatus(acc, chain);
      }
    } catch (e) {
      setError(describeError(e));
      setStatus("disconnected");
    }
  }, [applyStatus, connectProvider, evaluateNetwork, switchChain]);

  const switchToMonad = useCallback(async () => {
    const etht = hasWindowEthereum();
    if (!etht) return;
    setError(null);
    const acc = accountRef.current;
    const switched = await switchChain(etht);
    const chain = await evaluateNetwork(etht);
    if (switched && chain === CHAIN_ID) await connectProvider();
    applyStatus(acc, chain);
  }, [applyStatus, connectProvider, evaluateNetwork, switchChain]);

  const disconnect = useCallback(() => {
    setAccount(null);
    setChainId(null);
    setBrowserProvider(null);
    setError(null);
    setStatus("disconnected");
  }, []);

  // --- Live wallet events: account switched, network switched, disconnected ---
  useEffect(() => {
    const etht = hasWindowEthereum();
    if (!etht?.on) return;

    const onAccountsChanged = async (args: unknown[]) => {
      const accs = args as string[];
      if (!accs?.length) {
        disconnect();
        return;
      }
      const acc = accs[0].toLowerCase();
      setAccount(acc);
      const chain = await evaluateNetwork(etht!);
      if (chain === CHAIN_ID) await connectProvider();
      applyStatus(acc, chain);
    };
    const onChainChanged = async (args: unknown[]) => {
      const id = parseInt(String(args[0]), 16);
      setChainId(id);
      const acc = accountRef.current;
      if (id === CHAIN_ID) await connectProvider();
      applyStatus(acc, id);
    };
    const onDisconnect = () => disconnect();

    etht.on("accountsChanged", onAccountsChanged);
    etht.on("chainChanged", onChainChanged);
    (etht as MinimalEip1193).on?.("disconnect", onDisconnect);
    return () => {
      etht.removeListener?.("accountsChanged", onAccountsChanged);
      etht.removeListener?.("chainChanged", onChainChanged);
      etht.removeListener?.("disconnect", onDisconnect);
    };
  }, [applyStatus, connectProvider, disconnect, evaluateNetwork]);

  return {
    status,
    account,
    chainId,
    browserProvider,
    publicProvider,
    error,
    connect,
    switchToMonad,
    disconnect,
    clearError: () => setError(null),
  };
}