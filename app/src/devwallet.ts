// ---------------------------------------------------------------------------
// Dev-only "wallet" shim (NOT for production use).
//
// Activated by opening the app with `?dev-wallet=1` in the URL. It installs a
// minimal EIP-1193 provider backed by a JsonRpcProvider + Wallet (ethers v6),
// letting a developer exercise the full UI (connect, balances, previews,
// transaction lifecycle, error banners) in a plain browser with no MetaMask
// extension.
//
// With `VITE_DEV_WALLET_KEY` set in app/.env, the shim signs with that key
// (transactions are real broadcasts and need real gas — the disposable test
// key in the repo has near-zero MON, so writes predictably fail with a clear
// "insufficient funds" message, which is itself a useful failure-path test).
// Without a key it uses a fresh random key with no funds (reads/previews
// still work; any write fails the same way).
//
// Never enable this in production, and never set a private key you care about.
// ---------------------------------------------------------------------------

import { JsonRpcProvider, Wallet } from "ethers";
import { RPC_URL } from "./config";

const enum Methods {
  RequestAccounts = "eth_requestAccounts",
  Accounts = "eth_accounts",
  ChainId = "eth_chainId",
  NetVersion = "net_version",
  SendTransaction = "eth_sendTransaction",
  SwitchChain = "wallet_switchEthereumChain",
  AddChain = "wallet_addEthereumChain",
  Sign = "eth_sign",
  PersonalSign = "personal_sign",
  SignTyped = "eth_signTypedData_v4",
}

export function isDevWalletEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("dev-wallet")
  );
}

export function installDevWallet(): void {
  const key = (import.meta.env.VITE_DEV_WALLET_KEY as string | undefined)?.trim() || "";
  const publicProvider = new JsonRpcProvider(RPC_URL);
  // jsonrpcProvider.send() needs a Method-typed payload compatible with
  // ethers' Request; we only forward well-known JSON-RPC methods here.
  const wallet = new Wallet(key || Wallet.createRandom().privateKey, publicProvider);

  const source = key ? "disposable test key" : "random key (no funds)";
  console.warn(
    `[dev-wallet] simulating an EIP-1193 wallet with ${source} ` +
      `(address ${wallet.address}). Query param ?dev-wallet=1 is a DEV-ONLY test tool.`
  );

  const ethereum = {
    isMetaMask: true,
    chainId: "0x279f",
    request: async (args: { method: string; params?: unknown[] }) => {
      const { method, params = [] } = args;
      switch (method) {
        case Methods.RequestAccounts:
        case Methods.Accounts:
          return [wallet.address];
        case Methods.ChainId:
          return "0x279f";
        case Methods.NetVersion:
          return "10143";
        case Methods.SwitchChain:
        case Methods.AddChain:
          return null; // already on Monad Testnet
        case Methods.SendTransaction:
          return wallet.sendTransaction(params[0] as Record<string, unknown>).then((tx) => tx.hash);
        case Methods.Sign:
        case Methods.PersonalSign:
        case Methods.SignTyped:
          return Promise.reject({ code: 4001, message: "Dev wallet: signing disabled by design" });
        default:
          // Forward every other JSON-RPC call (eth_call, eth_getBalance,
          // eth_getTransactionReceipt, …) straight to the public RPC.
          return publicProvider.send(method, params as never);
      }
    },
  };

  window.ethereum = ethereum;
}