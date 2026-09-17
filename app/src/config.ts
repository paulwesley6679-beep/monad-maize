// ---------------------------------------------------------------------------
// Chain + deployed-contract configuration for the Monad Maize web app.
//
// MONAD TESTNET ONLY (chain id 10143). No mainnet, no real value.
//
// Sources (all documented in the prior tasks, see spike/README.md):
//   - Monad testnet RPC / chain id / explorer:
//       https://docs.monad.xyz/developer-essentials/testnet
//       RPC      : https://testnet-rpc.monad.xyz
//       Chain id : 10143 (0x279f)
//       Explorer : https://testnet.monadvision.com
//   - Core product addresses (PriceOracle, MockUSD, MzngnToken,
//     CollateralVault): deployed by scripts/core.ts in Task 02; the on-chain
//     artifacts table in spike/README.md is the canonical reference.
//       PriceOracle     : 0x914265f10042c56020205c4258ec19f99024e6a5
//       MockUSD         : 0xe4d3bd26ab76f5e7a21122feeec0bc0d86547e2e
//       MzngnToken      : 0x7f895bf9bbe1ef044af95c3c6d1d842e96cda8f7
//       CollateralVault : 0x5eee7da8bdb8680da889502f655c5c2a5bc9cddb
//
// Verified live at the time of writing via eth_getCode (all 4 have bytecode).
// ---------------------------------------------------------------------------

export const CHAIN_ID = 10143;
export const CHAIN_NAME = "Monad Testnet";

// Public RPC endpoints. CORS-enabled (verified: returns
// Access-Control-Allow-Origin for browser origins), so public reads work
// before a wallet is connected.
//
// The primary endpoint is intermittently slow/unreachable from some networks
// (requests hang for >10s or die at the TCP level → "Failed to fetch" with no
// HTTP status). To stay resilient the app reads/broadcasts through
// lib/provider.ts, which retries each request across PRIMARY → FALLBACK with
// a per-attempt timeout. Both endpoints below are overridable at dev/build
// time via Vite env (see .env.example):
//   VITE_RPC_URL          — primary (default: testnet-rpc.monad.xyz)
//   VITE_RPC_FALLBACK_URL — fallback (default: monad-testnet.drpc.org)
const _envRpc = (import.meta.env.VITE_RPC_URL as string | undefined)?.trim();
const _envFallback = (import.meta.env.VITE_RPC_FALLBACK_URL as string | undefined)?.trim();

export const RPC_URL = _envRpc || "https://testnet-rpc.monad.xyz";
export const RPC_FALLBACK_URL = _envFallback || "https://monad-testnet.drpc.org";
/** Per-attempt timeout used by the resilient RPC client (lib/provider.ts). */
export const RPC_TIMEOUT_MS = 12_000;

export const EXPLORER_URL = "https://testnet.monadvision.com";
export const EXPLORER_TX = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;

// --- Deployed Task 02 core product contracts (see provenance comment above) ---
export const PRICE_ORACLE_ADDRESS = "0x914265f10042c56020205c4258ec19f99024e6a5";
export const MOCKUSD_ADDRESS = "0xe4d3bd26ab76f5e7a21122feeec0bc0d86547e2e";
export const MZNGN_ADDRESS = "0x7f895bf9bbe1ef044af95c3c6d1d842e96cda8f7";
export const COLLATERAL_VAULT_ADDRESS = "0x5eee7da8bdb8680da889502f655c5c2a5bc9cddb";

// --- Token / price decimals ---
// mUSD collateral mirrors "USD", 6 dp (same scale as the oracle price).
export const MOCKUSD_SYMBOL = "mUSD";
export const MOCKUSD_DECIMALS = 6;
// mzNGN is an 18 dp ERC-20.
export const MZNGN_SYMBOL = "mzNGN";
export const MZNGN_DECIMALS = 18;
// Maize price quoted in mUSD per 100kg bag, 6 dp.
export const PRICE_DECIMALS = 6;

// Vault constants (CollateralVault.sol): 150% collateral ratio and a 1.00 mUSD
// minimum mint. Mirrors the contract constants for client-side validation.
export const COLLATERAL_RATIO_BPS = 15000; // 150%
export const BPS_DENOMINATOR = 10000;
export const MIN_COLLATERAL_MUSD = "1.00"; // dust guard on mint

// --- MetaMask wallet_addEthereumChain / wallet_switchEthereumChain params ---
export const MONAD_TESTNET_PARAMS = {
  chainId: "0x279f", // 10143
  chainName: CHAIN_NAME,
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER_URL],
};

// Refresh cadence for on-screen live data (oracle price, balances).
export const POLL_INTERVAL_MS = 10_000;