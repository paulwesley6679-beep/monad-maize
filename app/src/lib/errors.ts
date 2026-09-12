// ---------------------------------------------------------------------------
// Error → plain-English message mapping.
//
// Every user-triggerable failure path in the app funnels through describeError
// so the UI shows something a non-technical person can act on, instead of a
// raw stack trace.
// ---------------------------------------------------------------------------

export interface AppError {
  /** Short headline, e.g. "Transaction rejected" */
  title: string;
  /** Longer human-readable explanation + hint on what to do. */
  message: string;
}

const has = (e: unknown, needle: string) =>
  `${JSON.stringify(e)}`.toLowerCase().includes(needle.toLowerCase());

const r = (e: unknown) => ((e as { reason?: string })?.reason ?? "") + "|" +
  ((e as { data?: string })?.data ?? "") + "|" +
  String((e as { message?: string })?.message ?? e);

/** Pick a message for a single thrown error. Fallback: raw-ish message. */
function describeOne(e: unknown): AppError {
  const code = (e as { code?: unknown })?.code;
  const info = (e as { info?: { error?: { reason?: string; message?: string } } })?.info?.error;
  const revertReason = info?.reason || info?.message || (e as { reason?: string })?.reason;
  const msg = r(e);

  // --- User rejected the request (MetaMask code 4001, ethers ACTION_REJECTED) ---
  if (code === 4001 || code === "ACTION_REJECTED" || has(msg, "user rejected") || has(msg, "action rejected")) {
    return {
      title: "Transaction rejected by user",
      message: "You declined the transaction in your wallet. Nothing was sent — retry when you're ready.",
    };
  }

  // --- Wallet not installed / not detected ---
  if (has(msg, "request is not supported") || has(msg, "ethereum provider")) {
    return {
      title: "No wallet detected",
      message:
        "Install the MetaMask browser extension (or another EIP-1193 wallet) and reload this page to connect.",
    };
  }

  // --- Wallet requests (eth_requestAccounts / switch / add chain) ---
  if (code === -32002) {
    return {
      title: "Request already pending",
      message: "A connection request is already waiting inside MetaMask — open the extension and approve it.",
    };
  }
  if (code === 4902) {
    return {
      title: "Monad Testnet not added to your wallet",
      message: "Your wallet does not know the Monad Testnet network yet. Tap “Switch to Monad” again and approve adding the network.",
    };
  }
  if (has(msg, "wallet_switchethereumchain") || has(msg, "wallet_addethereumchain")) {
    return {
      title: "Network switch declined",
      message: "You declined the network switch. The app only works on Monad Testnet (chain 10143).",
    };
  }

  // --- Insufficient MON for gas ---
  // ethers v6 wraps RPC-level broadcast rejections like
  //   could not coalesce error (error={ "code": -32000, "message": "Signer had
  //   insufficient balance" }, payload={...})  → UNKNOWN_ERROR
  // Match on the -32000 tag or the nested "Signer had insufficient balance"
  // string, not just the classic "insufficient funds for gas" wording.
  if (
    has(msg, "insufficient funds") ||
    (code === -32000 && has(msg, "insufficient")) ||
    has(msg, "signer had insufficient balance")
  ) {
    return {
      title: "Not enough MON for gas",
      message:
        "Your wallet needs a little testnet MON to pay the transaction fee. Get some from https://faucet.monad.xyz and retry.",
    };
  }

  // --- Transaction reverted on-chain (decoded or stringified revert) ---
  if (code === "CALL_EXCEPTION" || has(msg, "reverted") || has(msg, "execution reverted")) {
    const reason = String(revertReason || "");
    if (has(reason, "insufficientcollateral") && !has(reason, "mzngn")) {
      return {
        title: "Mint below the minimum",
        message: "The vault requires at least 1.00 mUSD of collateral per mint. Enter a larger amount.",
      };
    }
    if (has(reason, "redeemtoosmall")) {
      return {
        title: "Redeem amount too small",
        message: "The vault refuses to redeem such a tiny amount of mzNGN — try a larger amount.",
      };
    }
    if (has(reason, "stale price")) {
      return {
        title: "Maize price feed is stale",
        message:
          "The oracle price is older than its freshness window, so the vault has paused minting and redeeming until a new price is published.",
      };
    }
    if (has(reason, "zeroprice")) {
      return {
        title: "Maize price not published yet",
        message: "The oracle has no price yet. Mint/redeem will work once the first price is published.",
      };
    }
    if (has(reason, "allowance exceeded")) {
      return {
        title: "mUSD allowance missing",
        message:
          "The vault was not approved to spend your mUSD. This happens automatically in the normal mint flow — reconnect and try again, or approve manually.",
      };
    }
    if (has(reason, "burn exceeds balance") || has(reason, "insufficient balance")) {
      return {
        title: "Not enough balance",
        message: "You tried to mint/redeem more than you hold. Check your balances and try a smaller amount.",
      };
    }
    if (reason) {
      return {
        title: "Transaction reverted on-chain",
        message: `The contract rejected the transaction: “${reason}”.`,
      };
    }
    return {
      title: "Transaction reverted on-chain",
      message: "The contract rejected the transaction. Your balance was not changed.",
    };
  }

  // --- Network / RPC flakiness ---
  if (has(msg, "networkerror") || code === "NETWORK_ERROR" || code === "SERVER_ERROR" || code === "TIMEOUT") {
    return {
      title: "Network hiccup",
      message: "Couldn't reach the Monad testnet RPC. This is usually transient — wait a moment and retry.",
    };
  }

  // --- Generic fallback ---
  return {
    title: "Something went wrong",
    message: msg || "An unexpected error occurred. See the console for details.",
  };
}

/**
 * Collapse an unknown thrown value into a user-friendly AppError. ethers v6
 * sometimes wraps the real contract error two levels deep (e.g. in
 * `info.error.cause`), so walk a few levels before giving up.
 */
export function describeError(e: unknown): AppError {
  if (!e) return { title: "Something went wrong", message: "Unknown error." };
  const seen = new Set<unknown>();
  let cur: unknown = e;
  for (let depth = 0; depth < 4; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const msg = String((cur as { message?: unknown })?.message ?? "");
    // If this layer is a real revert with a reason, use it directly.
    if (
      (cur as { code?: unknown })?.code === "CALL_EXCEPTION" ||
      has(msg, "reverted") ||
      has(msg, "execution reverted")
    ) {
      return describeOne(cur);
    }
    // Peel off ethers "Error: processing response" wrapper layers.
    const cause = (cur as { cause?: unknown })?.cause;
    const inner = (cur as { info?: { error?: { cause?: unknown } } })?.info?.error?.cause;
    const next = cause ?? inner;
    if (next === undefined || next === cur) break;
    cur = next;
  }
  return describeOne(cur);
}