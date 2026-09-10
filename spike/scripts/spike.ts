/**
 * End-to-end spike: SPIKE token + Kuru market vs testnet USDC + one trade.
 *
 * Runs entirely on MONAD TESTNET (chain 10143). Sequence:
 *   1. preflight MON (gas) balance
 *   2. deploy SPIKE ERC-20 (artifacts/SpikeToken.json), mint sellable supply
 *   3. create SPIKE/USDC market through the official Kuru Router
 *      (ParamCreator.deployMarket -> Router.deployProxy, quote = official testnet USDC)
 *   4. check USDC balance; deposit it into the Kuru MarginAccount (funds the maker bid)
 *   5. place a post-only limit BUY (maker) 1000 SPIKE @ 0.001 USDC
 *   6. place a fill-or-kill market SELL (taker) 900 SPIKE, min out 0.8 USDC
 *   7. verify on-chain: Trade events, L2 book, token balances, maker order struct
 *
 * Re-runnability: set SPIKE_TOKEN_ADDRESS / MARKET_ADDRESS in .env to reuse an
 * already deployed token/market (e.g. to continue after funding the wallet).
 * Results of the last run are written to .spike-result.json (gitignored).
 *
 * Usage: npm run spike
 */
import { ethers, BigNumber } from "ethers";
import * as KuruSdk from "@kuru-labs/kuru-sdk";
import * as cfg from "../src/config";
import { parseEvents } from "../src/events";
import * as fs from "fs";
import * as path from "path";

const ORDERBOOK_ABI = require("@kuru-labs/kuru-sdk/abi/OrderBook.json").abi;
const ERC20_ABI = require("@kuru-labs/kuru-sdk/abi/IERC20.json").abi;

const RESULT_FILE = path.join(__dirname, "..", ".spike-result.json");
const MIN_MON_GAS = "0.05"; // soft gate for gas (testnet gas is cheap)

const erc20ReadAbi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

interface RunResult {
  wallet: string;
  chainId: number;
  tokenAddress: string;
  tokenTxHash: string;
  marketAddress: string;
  marketTxHash: string;
  marginDepositTxHash?: string;
  limitOrderId?: string;
  limitTxHash?: string;
  marketSellTxHash?: string;
  trades?: Array<{ orderId: string; price: string; filledSize: string; makerIsBuy: boolean }>;
  verification?: Record<string, unknown>;
}

function saveResult(r: RunResult) {
  fs.writeFileSync(RESULT_FILE, JSON.stringify(r, null, 2));
}

function fundingInstructions(walletAddress: string): string {
  return [
    "",
    "========================================================================",
    "SPIKE cannot trade yet: the disposable wallet needs testnet funds.",
    `  Wallet: ${walletAddress}`,
    "",
    "  1) Testnet MON (gas) - one-time:",
    "     Open https://faucet.monad.xyz in a browser, paste the wallet address,",
    "     solve the CAPTCHA, claim (turnstile cannot be automated).",
    "     The Monad faucet backend (faucet.molandak.org /api/v1/faucet) requires",
    "     Cloudflare Turnstile + FingerprintJS, so a normal browser is required.",
    "",
    "  2) Testnet USDC (quote for the orderbook) - Kuru's official tUSDC",
    "     address: " + cfg.TESTNET_USDC,
    "     There is no public mint. Monetarily worthless but must be obtained from",
    "     an existing holder. Options (human-in-the-loop, browser required):",
    "       - Kuru app 'Lite Swap' (https://www.kuru.io) MON -> USDC testnet",
    "       - Kuru testnet faucet (https://docs.kuru.io -> testnet faucet)",
    "     Send >= " + cfg.MARGIN_DEPOSIT_USDC + " tUSDC to the wallet above.",
    "",
    "  After funding, simply re-run:  npm run spike",
    "=========================================================================",
    "",
  ].join("\n");
}

async function main() {
  // ---------------------------------------------------------------- provider
  const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  const network = await provider.getNetwork();
  console.log("== Network ==");
  console.log("chainId:", network.chainId, "(expected 10143)");
  if (network.chainId !== cfg.CHAIN_ID) {
    throw new Error(`Unexpected chain ${network.chainId}, expected ${cfg.CHAIN_ID}`);
  }
  console.log("block  :", await provider.getBlockNumber());

  const privateKey = cfg.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set in .env");
  const wallet = new ethers.Wallet(privateKey, provider);
  const walletAddress = wallet.address.toLowerCase();
  console.log("wallet :", walletAddress);

  const monBal = await wallet.getBalance();
  console.log("MON    :", ethers.utils.formatEther(monBal));
  if (monBal.lt(ethers.utils.parseEther(MIN_MON_GAS))) {
    console.log(fundingInstructions(walletAddress));
    throw new Error(
      `Not enough MON for gas (need >= ${MIN_MON_GAS}). Fund the wallet, then re-run.`
    );
  }

  const usdc = new ethers.Contract(cfg.TESTNET_USDC, erc20ReadAbi, provider);
  const usdcBal = await usdc.balanceOf(walletAddress);
  console.log("USDC   :", ethers.utils.formatUnits(usdcBal, cfg.TESTNET_USDC_DECIMALS));

  const MONADLINK = (hash: string) => `${cfg.EXPLORER}/tx/${hash}`;

  // ---------------------------------------------------------------- token
  let tokenAddress = (process.env.SPIKE_TOKEN_ADDRESS || "").toLowerCase();
  let tokenTxHash = "";
  let spikeToken: ethers.Contract;
  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "artifacts", "SpikeToken.json"), "utf8")
  );

  if (tokenAddress) {
    console.log("\n== SPIKE token (reusing SPIKE_TOKEN_ADDRESS) ==");
    spikeToken = new ethers.Contract(tokenAddress, artifact.abi, wallet);
  } else {
    console.log("\n== 1) Deploy SPIKE token ==");
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    // SpikeToken constructor mints the initial supply to the deployer (owner).
    const initialSupply = ethers.utils.parseUnits(cfg.SPIKE_INITIAL_SUPPLY, cfg.SPIKE_DECIMALS);
    const deployed = await factory.deploy(initialSupply);
    const receipt = await deployed.deployTransaction.wait(1);
    tokenAddress = deployed.address.toLowerCase();
    tokenTxHash = deployed.deployTransaction.hash;
    spikeToken = deployed;
    console.log("token  :", tokenAddress);
    console.log("tx     :", MONADLINK(tokenTxHash));
  }

  // Mint sellable SPIKE to the wallet (skip when already holding enough).
  const spikeBal = await spikeToken.balanceOf(walletAddress);
  const need = ethers.utils.parseUnits(cfg.MARKET_SELL_SIZE, cfg.SPIKE_DECIMALS);
  if (spikeBal.lt(need)) {
    const mintAmount = ethers.utils.parseUnits(cfg.SPIKE_MINT_TO_SELF, cfg.SPIKE_DECIMALS);
    const m = await spikeToken.connect(wallet).mint(walletAddress, mintAmount);
    const mReceipt = await m.wait(1);
    console.log("mint tx :", MONADLINK(mReceipt.transactionHash));
  } else {
    console.log("SPIKE balance already >= sell size, skipping mint");
  }

  // ---------------------------------------------------------------- market
  let marketAddress = (process.env.MARKET_ADDRESS || "").toLowerCase();
  let marketTxHash = "";
  if (marketAddress) {
    console.log("\n== Kuru market (reusing MARKET_ADDRESS) ==");
  } else {
    console.log("\n== 2) Create SPIKE/USDC market on Kuru (Router.deployProxy) ==");
    const creator = new KuruSdk.ParamCreator();
    const p = creator.calculatePrecisions(
      cfg.TARGET_PRICE_QUOTE, // 1 USDC
      cfg.TARGET_PRICE_BASE, // per 1000 SPIKE -> 0.001 USDC/SPIKE
      cfg.MAX_PRICE,
      cfg.MIN_SIZE
    );
    console.log("precisions:", {
      pricePrecision: p.pricePrecision.toString(),
      sizePrecision: p.sizePrecision.toString(),
      tickSize: p.tickSize.toString(),
      minSize: p.minSize.toString(),
      maxSize: p.maxSize.toString(),
    });

    marketAddress = await creator.deployMarket(
      wallet,
      cfg.KURU_ROUTER_TESTNET,
      cfg.MARKET_TYPE,
      tokenAddress,
      cfg.TESTNET_USDC,
      p.sizePrecision,
      p.pricePrecision,
      p.tickSize,
      p.minSize,
      p.maxSize,
      cfg.TAKER_FEE_BPS,
      cfg.MAKER_FEE_BPS,
      cfg.KURU_AMM_SPREAD
    );
    marketAddress = marketAddress.toLowerCase();
    const market = new ethers.Contract(marketAddress, ORDERBOOK_ABI, provider);
    // Re-fetch the deploy tx hash from recent Router logs (best effort).
    const marketRegisteredEvent = await findMarketRegisteredTx(provider, tokenAddress, marketAddress);
    marketTxHash = marketRegisteredEvent || "";
    console.log("market :", marketAddress);
    console.log("vault  :", (await market.getVaultParams())?.[0] ?? "n/a");
    console.log("tx     :", marketTxHash ? MONADLINK(marketTxHash) : marketTxHash);
  }

  const marketParams = await KuruSdk.ParamFetcher.getMarketParams(provider, marketAddress);
  console.log("\n== Market params (on-chain) ==");
  console.log("base :", marketParams.baseAssetAddress, `(${marketParams.baseAssetDecimals} dec)`);
  console.log("quote:", marketParams.quoteAssetAddress, `(${marketParams.quoteAssetDecimals} dec)`);
  console.log("pricePrecision:", marketParams.pricePrecision.toString());
  console.log("sizePrecision :", marketParams.sizePrecision.toString());
  console.log("tickSize      :", marketParams.tickSize.toString());
  console.log("minSize       :", marketParams.minSize.toString());
  console.log("maxSize       :", marketParams.maxSize.toString());
  console.log("takerFeeBps   :", marketParams.takerFeeBps.toString());
  console.log("makerFeeBps   :", marketParams.makerFeeBps.toString());

  const result: RunResult = {
    wallet: walletAddress,
    chainId: network.chainId,
    tokenAddress,
    tokenTxHash,
    marketAddress,
    marketTxHash,
  };
  saveResult(result);

  // ---------------------------------------------------------------- funding gate
  const neededUsdc = ethers.utils.parseUnits(cfg.MARGIN_DEPOSIT_USDC, cfg.TESTNET_USDC_DECIMALS);
  if (usdcBal.lt(neededUsdc)) {
    console.log(fundingInstructions(walletAddress));
    console.log(
      `Deployed token ${tokenAddress} and market ${marketAddress}; set these in .env ` +
        `(SPIKE_TOKEN_ADDRESS / MARKET_ADDRESS) to continue after funding.`
    );
    throw new Error(
      `Wallet needs >= ${cfg.MARGIN_DEPOSIT_USDC} testnet USDC (has ${ethers.utils.formatUnits(
        usdcBal, cfg.TESTNET_USDC_DECIMALS
      )}). Fund it, then re-run.`
    );
  }

  // ------------------------------------------------------------- margin deposit
  console.log(`\n== 3) Deposit ${cfg.MARGIN_DEPOSIT_USDC} USDC into MarginAccount (funds the maker bid) ==`);
  const depReceipt = await KuruSdk.MarginDeposit.deposit(
    wallet,
    cfg.KURU_MARGIN_TESTNET,
    walletAddress,
    cfg.TESTNET_USDC,
    cfg.MARGIN_DEPOSIT_USDC,
    cfg.TESTNET_USDC_DECIMALS,
    true
  );
  console.log("deposit tx:", MONADLINK(depReceipt.transactionHash));
  result.marginDepositTxHash = depReceipt.transactionHash;
  saveResult(result);

  // ------------------------------------------------------------ limit buy (maker)
  console.log(`\n== 4) Place post-only limit BUY ${cfg.LIMIT_BUY_SIZE} SPIKE @ ${cfg.LIMIT_BUY_PRICE} USDC (maker) ==`);
  const limitReceipt = await KuruSdk.GTC.placeLimit(wallet, marketAddress, marketParams, {
    price: cfg.LIMIT_BUY_PRICE,
    size: cfg.LIMIT_BUY_SIZE,
    isBuy: true,
    postOnly: true,
  });
  const limitEvents = parseEvents(limitReceipt);
  if (!limitEvents.newOrderIds.length) {
    throw new Error("Limit order placed but no OrderCreated event found in receipt");
  }
  const orderId = limitEvents.newOrderIds[0];
  console.log("limit tx :", MONADLINK(limitReceipt.transactionHash));
  console.log("orderId  :", orderId.toString());
  result.limitOrderId = orderId.toString();
  result.limitTxHash = limitReceipt.transactionHash;
  saveResult(result);

  console.log("\n  Order book after limit buy:");
  const l2Before = await KuruSdk.OrderBook.getL2OrderBook(provider, marketAddress, marketParams);
  console.log("  bids:", JSON.stringify(l2Before.bids.slice(0, 3)));
  console.log("  asks:", JSON.stringify(l2Before.asks.slice(0, 3)));
  if (l2Before.bids.length === 0) {
    throw new Error("Limit buy not visible in L2 book - order placement failed");
  }

  // ------------------------------------------------------------- market sell
  console.log(`\n== 5) Place fill-or-kill market SELL ${cfg.MARKET_SELL_SIZE} SPIKE (taker, min out ${cfg.MARKET_SELL_MIN_OUT} USDC) ==`);
  const sellReceipt = await KuruSdk.IOC.placeMarket(wallet, marketAddress, marketParams, {
    approveTokens: true,
    isBuy: false,
    size: cfg.MARKET_SELL_SIZE,
    minAmountOut: cfg.MARKET_SELL_MIN_OUT,
    isMargin: false,
    fillOrKill: true,
  });
  const sellEvents = parseEvents(sellReceipt);
  if (!sellEvents.trades.length) {
    throw new Error("Market sell executed but no Trade event found in receipt");
  }
  console.log("sell tx   :", MONADLINK(sellReceipt.transactionHash));
  console.log("Trade events (maker side isBuy=true for the resting buy):");
  result.trades = sellEvents.trades.map((t) => ({
    orderId: t.orderId.toString(),
    price: t.price.toString(),
    filledSize: t.filledSize.toString(),
    makerIsBuy: t.isBuy,
  }));
  for (const t of sellEvents.trades) {
    console.log(
      `  orderId=${t.orderId} price=${t.price.toString()} filledSize=${t.filledSize.toString()} ` +
        `makerIsBuy=${t.isBuy} maker=${t.makerAddress}`
    );
  }
  saveResult(result);

  // ------------------------------------------------------------- verification
  console.log("\n== 6) On-chain verification ==");

  const l2After = await KuruSdk.OrderBook.getL2OrderBook(provider, marketAddress, marketParams);
  console.log("Order book after trade:");
  console.log("  bids:", JSON.stringify(l2After.bids.slice(0, 3)));
  console.log("  asks:", JSON.stringify(l2After.asks.slice(0, 3)));

  const spikeAfter = await spikeToken.balanceOf(walletAddress);
  const usdcAfter = await usdc.balanceOf(walletAddress);
  console.log("wallet SPIKE:", ethers.utils.formatUnits(spikeAfter, cfg.SPIKE_DECIMALS));
  console.log("wallet USDC :", ethers.utils.formatUnits(usdcAfter, cfg.TESTNET_USDC_DECIMALS));

  const orderbook = new ethers.Contract(marketAddress, ORDERBOOK_ABI, provider);
  const order = await orderbook.s_orders(orderId.toNumber());
  console.log("maker order struct (s_orders):");
  console.log("  ownerAddress:", order.ownerAddress);
  console.log("  size (raw)  :", order.size.toString(), `= ${ethers.utils.formatUnits(order.size, marketParams.sizePrecision)} SPIKE`);
  console.log("  price (raw) :", order.price.toString(), `= ${ethers.utils.formatUnits(order.price, marketParams.pricePrecision)} USDC`);
  console.log("  isBuy       :", order.isBuy);

  // Assertions
  const expectedFilled = ethers.utils.parseUnits(cfg.MARKET_SELL_SIZE, marketParams.sizePrecision);
  const totalFilled = sellEvents.trades.reduce((a, t) => a.add(t.filledSize), BigNumber.from(0));
  if (!totalFilled.eq(expectedFilled)) {
    throw new Error(
      `Trade filled ${totalFilled.toString()} of ${expectedFilled.toString()} sizePrecision units`
    );
  }
  const expectedSpikeLeft = spikeBal.sub(ethers.utils.parseUnits(cfg.MARKET_SELL_SIZE, cfg.SPIKE_DECIMALS));
  if (!spikeAfter.eq(expectedSpikeLeft)) {
    console.log(`  NOTE: SPIKE balance delta not exactly ${cfg.MARKET_SELL_SIZE} (taker fees/rounding)`);
  }
  if (usdcAfter.lt(ethers.utils.parseUnits(cfg.MARKET_SELL_MIN_OUT, cfg.TESTNET_USDC_DECIMALS))) {
    throw new Error(`USDC received below minAmountOut (${ethers.utils.formatUnits(usdcAfter, 6)})`);
  }

  result.verification = {
    walletSpike: ethers.utils.formatUnits(spikeAfter, cfg.SPIKE_DECIMALS),
    walletUsdc: ethers.utils.formatUnits(usdcAfter, cfg.TESTNET_USDC_DECIMALS),
    remainingMakerBid: {
      sizeRaw: order.size.toString(),
      priceRaw: order.price.toString(),
      isBuy: order.isBuy,
    },
    l2Bids: l2After.bids.slice(0, 3),
    l2Asks: l2After.asks.slice(0, 3),
  };
  saveResult(result);

  console.log("\n========================================================================");
  console.log("SPIKE SPIKE COMPLETE - trade executed on-chain (Monad testnet)");
  console.log("  SPIKE token :", tokenAddress);
  console.log("  Market      :", marketAddress, "(SPIKE / official testnet USDC)");
  console.log("  Limit buy   :", cfg.LIMIT_BUY_SIZE, "SPIKE @", cfg.LIMIT_BUY_PRICE, "USDC (maker, orderId", orderId.toString() + ")");
  console.log("  Market sell :", cfg.MARKET_SELL_SIZE, "SPIKE taker order executed, filled", totalFilled.toString());
  console.log("  Sell tx     :", MONADLINK(sellReceipt.transactionHash));
  console.log("  Result file :", RESULT_FILE);
  console.log("========================================================================\n");
}

/**
 * Best-effort lookup of the Router tx hash that emitted MarketRegistered for the
 * given market, scanning recent blocks in chunks (public RPC caps eth_getLogs at
 * ~100-block ranges). Returns "" when not found (e.g. RPC log limits).
 */
async function findMarketRegisteredTx(
  provider: ethers.providers.JsonRpcProvider,
  baseAssetAddress: string,
  marketAddress: string
): Promise<string> {
  try {
    const topic = ethers.utils.id("MarketRegistered(address,address,address,address,uint32,uint96,uint32,uint96,uint96,uint256,uint256,uint96)");
    const latest = await provider.getBlockNumber();
    const CHUNK = 100;
    const from = Math.max(0, latest - 500);
    const decode = (data: string) =>
      ethers.utils.defaultAbiCoder.decode(
        ["address", "address", "address", "address", "uint32", "uint96", "uint32", "uint96", "uint96", "uint256", "uint256", "uint96"],
        data
      );
    for (let to = latest; to > from; to -= CHUNK) {
      const f = Math.max(from, to - CHUNK + 1);
      const logs = await provider.getLogs({ address: cfg.KURU_ROUTER_TESTNET, topics: [topic], fromBlock: f, toBlock: to });
      for (const log of logs) {
        const decoded = decode(log.data);
        if (decoded[2].toLowerCase() === marketAddress && decoded[0].toLowerCase() === baseAssetAddress.toLowerCase()) {
          return log.transactionHash;
        }
      }
    }
  } catch (e: any) {
    console.log("  (could not resolve deploy tx hash:", e?.message, ")");
  }
  return "";
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nSPIKE FAILED:", e?.message || e);
    process.exit(1);
  });