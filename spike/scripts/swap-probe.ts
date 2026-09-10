import { ethers } from "ethers";
import * as KuruSdk from "@kuru-labs/kuru-sdk";
import * as cfg from "../src/config";
import * as dotenv from "dotenv";

dotenv.config();

// Probe: can we acquire Kuru testnet USDC by swapping native MON through the
// official MON-USDC market (Router.anyToAnySwap)? Everything here is read-only
// (eth_call / views) so it works with a zero-balance wallet.
//
// Background: the resting L2 book of MON-USDC is empty, BUT the market's Kuru
// AMM vault may still quote liquidity. If the vault holds MON + USDC, then
//    Router.anyToAnySwap([market],[isBuy=false],[nativeSend=true],
//                        MON_NATIVE, USDC, amountIn, minAmountOut)  (payable)
// fills against the vault and returns USDC to the caller.

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  const marketAddress = cfg.KURU_MON_USDC_MARKET_TESTNET;
  const signer = new ethers.Wallet(cfg.PRIVATE_KEY || ethers.constants.AddressZero, provider);
  const walletAddress = signer.address;
  console.log("Wallet:", walletAddress);

  // 1) Market params + vault address
  const marketParams = await KuruSdk.ParamFetcher.getMarketParams(provider, marketAddress);
  console.log("\nMarket params:", {
    base: marketParams.baseAssetAddress,
    baseDecimals: marketParams.baseAssetDecimals,
    quote: marketParams.quoteAssetAddress,
    quoteDecimals: marketParams.quoteAssetDecimals,
    pricePrecision: marketParams.pricePrecision.toString(),
    sizePrecision: marketParams.sizePrecision.toString(),
  });

  const orderbook = new ethers.Contract(
    marketAddress, require("@kuru-labs/kuru-sdk/abi/OrderBook.json").abi, provider
  );
  const vaultParams = await orderbook.getVaultParams();
  const vaultAddress = vaultParams[0];
  console.log("Vault:", vaultAddress);

  // 2) Vault liquidity (balances inside the shared MarginAccount)
  const liq = await KuruSdk.Vault.getVaultLiquidity(
    vaultAddress,
    marketParams.baseAssetAddress,
    marketParams.quoteAssetAddress,
    cfg.KURU_MARGIN_TESTNET,
    provider
  );
  console.log("\nVault liquidity (raw units):", {
    base: liq.token1.balance.toString(),
    quote: liq.token2.balance.toString(),
  });
  console.log("Vault liquidity (human):", {
    base: ethers.utils.formatUnits(liq.token1.balance, marketParams.baseAssetDecimals),
    quote: ethers.utils.formatUnits(liq.token2.balance, marketParams.quoteAssetDecimals),
  });

  // 3) L2 book (resting orders only)
  const l2 = await KuruSdk.OrderBook.getL2OrderBook(provider, marketAddress, marketParams);
  console.log("\nL2 book: bids:", l2.bids.length, "asks:", l2.asks.length);
  console.log("  top bids:", JSON.stringify(l2.bids.slice(0, 3)));
  console.log("  top asks:", JSON.stringify(l2.asks.slice(0, 3)));

  // 4) Simulate Router.anyToAnySwap MON -> USDC (1 MON, min out 0)
  const router = new ethers.Contract(cfg.KURU_ROUTER_TESTNET, require("@kuru-labs/kuru-sdk/abi/Router.json").abi, provider);
  const amountIn = ethers.utils.parseEther("1");
  const minAmountOut = ethers.utils.parseUnits("0", 6);
  const MON_NATIVE = ethers.constants.AddressZero;
  try {
    const amountOut = await router.callStatic.anyToAnySwap(
      [marketAddress],
      [false],           // sell base (MON)
      [true],            // pay with native MON
      MON_NATIVE,
      cfg.TESTNET_USDC,
      amountIn,
      minAmountOut,
      { from: walletAddress, value: amountIn }
    );
    console.log("\nSIMULATED swap 1 MON -> USDC:",
      amountOut.toString(), "raw /", ethers.utils.formatUnits(amountOut, 6), "USDC (SUCCESS)");
    console.log("=> swappable MON->USDC via Router.anyToAnySwap once the wallet holds MON.");
  } catch (e: any) {
    console.log("\nSIMULATED swap 1 MON -> USDC FAILED:", e.reason || e.message || String(e));
    console.log("=> no executable MON->USDC liquidity through the official market right now.");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });