/**
 * Task 05: list mzNGN on a real Kuru orderbook market on MONAD TESTNET.
 *
 * Creates an MZNGN / MOCKUSD market through the official Kuru Router, funds it,
 * and executes a real on-chain trade, using only the Task 02 product contracts:
 *
 *   1. preflight chain/gas, verify Task 02 contracts are live (eth_getCode)
 *   2. top-up tokens when short (MockUSD owner mint; more importantly, the
 *      CollateralVault.mint path for mzNGN - the Task 03 integration)
 *   3. ParamCreator.calculatePrecisions + deployMarket (Router.deployProxy)
 *   4. MarginAccount deposits: mUSD backs the bid, mzNGN backs the ask
 *   5. post-only maker orders: BUY 20 mzNGN @ 61.44, SELL 20 @ 61.50144
 *   6. fill-or-kill taker market SELL 15 mzNGN (min out 915 mUSD)
 *   7. verify on-chain: Trade events, L2 book, s_orders structs, balances
 *
 * Anchor: 1 mzNGN = 61.44 mUSD (oracle last price 61.438026 mUSD/bag -> anchor
 * is the nearest book-aligned tick, 0.003% above spot). With tickBps=10 the raw
 * tick is 6144 (= 0.06144 mUSD): 61.44 = 1000 ticks, 61.50144 = 1001 ticks.
 *
 * Re-runnability: set MOCKUSD_ADDRESS / MZNGN_TOKEN_ADDRESS / COLLATERAL_VAULT_ADDRESS /
 * PRICE_ORACLE_ADDRESS / MARKET_ADDRESS in .env to reuse the deployed contracts
 * (defaults in src/config.ts point at the live Task 02 deployments). Each run
 * places fresh orders; balances/order book stack up like on any real book.
 * Results are written to .task05-result.json (gitignored).
 *
 * Usage: npm run list-on-kuru        (LIST_FORCE_TOPUP=1 to always demo the vault mint)
 */
import { ethers, BigNumber } from "ethers";
import * as KuruSdk from "@kuru-labs/kuru-sdk";
import * as cfg from "../src/config";
import { parseEvents } from "../src/events";
import * as fs from "fs";
import * as path from "path";

const ORDERBOOK_ABI = require("@kuru-labs/kuru-sdk/abi/OrderBook.json").abi;

const RESULT_FILE = path.join(__dirname, "..", ".task05-result.json");
const MIN_MON_GAS = "0.05";

// Fixed gas limit: skips flaky eth_estimateGas on the public testnet RPC
// (same pattern as scripts/spike.ts). Gas PRICE is left to the node.
const TX_OPTIONS = { gasLimit: ethers.BigNumber.from(2_000_000) };

const readArtifact = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", `${name}.json`), "utf8"));

/** Retry a read-only RPC call on transient SERVER_ERROR/TIMEOUT failures. */
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const transient = e?.code === "SERVER_ERROR" || e?.code === "TIMEOUT";
      if (!transient || attempt >= tries) throw e;
      const delay = Math.min(attempt * 2500, 10000);
      console.warn(`  (${label} flaked: ${String(e.message).slice(0, 100)} — retry ${attempt}/${tries - 1} in ${delay}ms)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Wrap wait() so it survives transient public-RPC poll errors (same as spike). */
function makeResilientTx<T extends ethers.providers.TransactionResponse>(tx: T): T {
  const wait = tx.wait.bind(tx);
  (tx as unknown as { wait: (c?: number) => Promise<ethers.providers.TransactionReceipt> }).wait = async (c?: number) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await wait(c);
      } catch (e: any) {
        if (e?.code !== "SERVER_ERROR" && e?.code !== "TIMEOUT") throw e;
        const delay = Math.min(attempt * 3000, 15000);
        console.warn(`  (receipt poll error: ${String(e.message).slice(0, 120)} — retrying in ${delay}ms)`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  };
  return tx;
}

/** Signer whose sendTransaction returns txs with a resilient wait(). */
function resilientSigner(s: ethers.Signer): ethers.Signer {
  return new Proxy(s, {
    get(target, prop: string | symbol, receiver) {
      if (prop === "sendTransaction") {
        return async (t: Record<string, unknown>) => makeResilientTx(await target.sendTransaction(t));
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * Best-effort lookup of the Router tx hash that emitted MarketRegistered for the
 * given market, scanning recent blocks in chunks (public RPC caps eth_getLogs).
 * Returns "" when not found.
 */
async function findMarketRegisteredTx(
  provider: ethers.providers.JsonRpcProvider,
  baseAssetAddress: string,
  marketAddress: string
): Promise<string> {
  try {
    const topic = ethers.utils.id("MarketRegistered(address,address,address,address,uint32,uint96,uint32,uint96,uint96,uint256,uint256,uint96)");
    const latest = await withRetry("getBlockNumber", () => provider.getBlockNumber());
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

interface RunResult {
  wallet: string;
  chainId: number;
  oracleAddress: string;
  oraclePriceMusdPerBag?: string;
  anchorPriceMusdPerMzngn: string;
  mockusdAddress: string;
  mzngnAddress: string;
  vaultAddress: string;
  vaultTopUpTxHash?: string;
  vaultTopUpMintedMzngn?: string;
  marketAddress: string;
  marketTxHash: string;
  marginDepositQuoteTxHash?: string;
  marginDepositBaseTxHash?: string;
  bidOrderId?: string;
  bidTxHash?: string;
  askOrderId?: string;
  askTxHash?: string;
  takerSellTxHash?: string;
  trades?: Array<{ orderId: string; priceRaw: string; priceHuman: string; filledSize: string; takerIsBuy: boolean }>;
  verification?: Record<string, unknown>;
}

async function main() {
  // ---------------------------------------------------------------- provider
  const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  const network = await withRetry("getNetwork", () => provider.getNetwork());
  console.log("== Network ==");
  console.log("chainId:", network.chainId, "(expected 10143)");
  if (network.chainId !== cfg.CHAIN_ID) throw new Error(`Unexpected chain ${network.chainId}`);
  const blockAtStart = await withRetry("getBlockNumber", () => provider.getBlockNumber());
  console.log("block  :", blockAtStart);

  const privateKey = cfg.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set in .env");
  const wallet = new ethers.Wallet(privateKey, provider);
  const walletAddress = wallet.address.toLowerCase();
  const signer = resilientSigner(wallet);
  const MONADLINK = (h: string) => `${cfg.EXPLORER}/tx/${h}`;
  const ADDRLINK = (a: string) => `${cfg.EXPLORER}/address/${a}`;
  console.log("wallet :", walletAddress);

  const monBal = await withRetry("getBalance", () => wallet.getBalance());
  console.log("MON    :", ethers.utils.formatEther(monBal));
  if (monBal.lt(ethers.utils.parseEther(MIN_MON_GAS))) {
    throw new Error(`Not enough MON for gas (need >= ${MIN_MON_GAS}). Fund the wallet, then re-run.`);
  }

  const forceTopUp = (process.env.LIST_FORCE_TOPUP || "").toLowerCase() === "1";

  const result: RunResult = {
    wallet: walletAddress,
    chainId: network.chainId,
    oracleAddress: "",
    anchorPriceMusdPerMzngn: cfg.LIST_BID_PRICE,
    mockusdAddress: "",
    mzngnAddress: "",
    vaultAddress: "",
    marketAddress: "",
    marketTxHash: "",
  };
  const save = () => fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  // ------------------------------------------------- core contract wiring
  const mockusdAddress = (process.env.MOCKUSD_ADDRESS || cfg.CORE_MOCKUSD_DEFAULT).toLowerCase();
  const mzngnAddress = (process.env.MZNGN_TOKEN_ADDRESS || cfg.MZNGN_TOKEN_DEFAULT).toLowerCase();
  const vaultAddress = (process.env.COLLATERAL_VAULT_ADDRESS || cfg.COLLATERAL_VAULT_DEFAULT).toLowerCase();
  const oracleAddress = (process.env.PRICE_ORACLE_ADDRESS || cfg.PRICE_ORACLE_DEFAULT).toLowerCase();
  result.mockusdAddress = mockusdAddress;
  result.mzngnAddress = mzngnAddress;
  result.vaultAddress = vaultAddress;
  result.oracleAddress = oracleAddress;

  console.log("\n== Task 02 contracts (on-chain check) ==");
  const mockusdArtifact = readArtifact("MockUSD");
  const mzngnArtifact = readArtifact("MzngnToken");
  const vaultArtifact = readArtifact("CollateralVault");
  const oracleArtifact = readArtifact("PriceOracle");
  for (const [label, addr, artifact] of [
    ["PriceOracle", oracleAddress, oracleArtifact],
    ["MockUSD", mockusdAddress, mockusdArtifact],
    ["MzngnToken", mzngnAddress, mzngnArtifact],
    ["CollateralVault", vaultAddress, vaultArtifact],
  ] as const) {
    const code = await withRetry(`${label}.getCode`, () => provider.getCode(addr));
    if (code === "0x" || code === "0x0") throw new Error(`${label} ${addr} has no code - deploy it first (npm run core)`);
    console.log(`${label.padEnd(15)} ${ADDRLINK(addr)} (code ok)`);
  }
  const mockusd = new ethers.Contract(mockusdAddress, mockusdArtifact.abi, signer);
  const mzngn = new ethers.Contract(mzngnAddress, mzngnArtifact.abi, signer);
  const vault = new ethers.Contract(vaultAddress, vaultArtifact.abi, signer);
  const oracle = new ethers.Contract(oracleAddress, oracleArtifact.abi, provider);

  const usdDecimals = Number(await mockusd.decimals());
  const mzngnDecimals = Number(await mzngn.decimals());
  if (usdDecimals !== 6) throw new Error(`MockUSD decimals ${usdDecimals}, expected 6`);
  if (mzngnDecimals !== 18) throw new Error(`MzngnToken decimals ${mzngnDecimals}, expected 18`);
  const oraclePrice = await oracle.price();
  result.oraclePriceMusdPerBag = ethers.utils.formatUnits(oraclePrice, 6);
  console.log(`oracle price: ${result.oraclePriceMusdPerBag} mUSD/bag (anchor ${cfg.LIST_BID_PRICE} mUSD/mzNGN)`);

  let usdBal = await mockusd.balanceOf(walletAddress);
  let mzngnBal = await mzngn.balanceOf(walletAddress);
  console.log(`wallet MOCKUSD : ${ethers.utils.formatUnits(usdBal, usdDecimals)}`);
  console.log(`wallet mzNGN   : ${ethers.utils.formatUnits(mzngnBal, mzngnDecimals)}`);

  // -------------------------------------------------------- 2) token top-ups
  console.log("\n== 2) Token top-ups (only when short; vault mint path for mzNGN) ==");

  // mUSD: owner-only mint (this wallet is the MockUSD owner from Task 02).
  const owner = await mockusd.owner();
  if (owner.toLowerCase() !== walletAddress) throw new Error(`MockUSD owner is ${owner}, not the wallet`);
  const needUsd = ethers.utils.parseUnits(cfg.LIST_MARGIN_QUOTE, usdDecimals).add(ethers.utils.parseUnits("100", usdDecimals));
  if (usdBal.lt(needUsd)) {
    const extra = ethers.utils.parseUnits(cfg.CORE_MOCKUSD_MINT_TO_SELF, usdDecimals);
    const m = await mockusd.mint(walletAddress, extra, TX_OPTIONS);
    const r = await m.wait(1);
    console.log("mockusd mint tx:", MONADLINK(r.transactionHash));
  } else {
    console.log("MOCKUSD balance sufficient, skipping mint");
  }

  // mzNGN: only the CollateralVault can mint (Task 03 integration). Deposit mUSD
  // into the vault when short (or LIST_FORCE_TOPUP=1 to demonstrate the loop).
  const needMzngn = ethers.utils.parseUnits(cfg.LIST_MARGIN_BASE, 18)
    .add(ethers.utils.parseUnits(cfg.LIST_TAKER_SELL_SIZE, 18))
    .add(ethers.utils.parseUnits("5", 18));
  if (mzngnBal.lt(needMzngn) || forceTopUp) {
    const deposit = ethers.utils.parseUnits(cfg.LIST_TOPUP_MUSD, 6);
    const preview: ethers.BigNumber = await withRetry("getMintPreview", () => vault.getMintPreview(deposit));
    console.log(`vault top-up: deposit ${cfg.LIST_TOPUP_MUSD} mUSD -> preview ${ethers.utils.formatUnits(preview, 18)} mzNGN`);
    const appr = await mockusd.approve(vaultAddress, deposit, TX_OPTIONS);
    await appr.wait(1);
    const mintTx = await vault.mint(deposit, TX_OPTIONS);
    const mintReceipt = await mintTx.wait(1);
    result.vaultTopUpTxHash = mintReceipt.transactionHash;
    result.vaultTopUpMintedMzngn = ethers.utils.formatUnits(preview, 18);
    console.log("vault mint tx :", MONADLINK(mintReceipt.transactionHash));
    mzngnBal = await mzngn.balanceOf(walletAddress);
    if (mzngnBal.lt(needMzngn)) {
      throw new Error(`mzNGN still short after top-up (${ethers.utils.formatUnits(mzngnBal, 18)}); raise LIST_TOPUP_MUSD`);
    }
  } else {
    console.log("mzNGN balance sufficient, skipping vault mint");
  }
  usdBal = await mockusd.balanceOf(walletAddress);
  mzngnBal = await mzngn.balanceOf(walletAddress);
  console.log(`balances after top-up -> MOCKUSD ${ethers.utils.formatUnits(usdBal, 6)}, mzNGN ${ethers.utils.formatUnits(mzngnBal, 18)}`);

  // ---------------------------------------------------------------- 3) market
  let marketAddress = (process.env.MARKET_ADDRESS || "").toLowerCase();
  let marketTxHash = "";
  let marketTxBlock: number | undefined;
  if (marketAddress) {
    console.log("\n== Kuru market (reusing MARKET_ADDRESS) ==");
  } else {
    console.log("\n== 3) Create MZNGN/MOCKUSD market on Kuru (Router.deployProxy) ==");
    const creator = new KuruSdk.ParamCreator();
    const p = creator.calculatePrecisions(
      cfg.LIST_TARGET_PRICE_QUOTE, // 61.44 mUSD * 100
      cfg.LIST_TARGET_PRICE_BASE, // per 100 mzNGN -> 61.44 mUSD/mzNGN
      cfg.LIST_MAX_PRICE,
      cfg.LIST_MIN_SIZE,
      cfg.LIST_TICK_SIZE_BPS
    );
    console.log("precisions:", {
      pricePrecision: p.pricePrecision.toString(),
      sizePrecision: p.sizePrecision.toString(),
      tickSize: p.tickSize.toString(),
      minSize: p.minSize.toString(),
      maxSize: p.maxSize.toString(),
    });
    console.log("grid check:",
      "61.44 ->", p.tickSize.mul(1000).toString(), "(aligned)", "|",
      "61.50144 ->", p.tickSize.mul(1001).toString(), "(aligned)", "|",
      "tick in mUSD:", ethers.utils.formatUnits(p.tickSize, Number(Math.log10(p.pricePrecision.toNumber()))));

    marketAddress = await creator.deployMarket(
      signer,
      cfg.KURU_ROUTER_TESTNET,
      cfg.LIST_MARKET_TYPE,
      mzngnAddress,
      mockusdAddress,
      p.sizePrecision,
      p.pricePrecision,
      p.tickSize,
      p.minSize,
      p.maxSize,
      cfg.LIST_TAKER_FEE_BPS,
      cfg.LIST_MAKER_FEE_BPS,
      cfg.LIST_KURU_AMM_SPREAD
    );
    marketAddress = marketAddress.toLowerCase();
    const market = new ethers.Contract(marketAddress, ORDERBOOK_ABI, provider);
    const vaultParams = await market.getVaultParams();
    marketTxHash = await findMarketRegisteredTx(provider, mzngnAddress, marketAddress);
    console.log("market :", ADDRLINK(marketAddress));
    console.log("vault  :", vaultParams?.[0] ?? "n/a");
    console.log("tx     :", marketTxHash ? MONADLINK(marketTxHash) : "(not resolved)");
  }
  result.marketAddress = marketAddress;
  result.marketTxHash = marketTxHash || "";
  save();

  const marketParams = await withRetry("getMarketParams", () => KuruSdk.ParamFetcher.getMarketParams(provider, marketAddress));
  console.log("\n== Market params (on-chain) ==");
  console.log("base :", marketParams.baseAssetAddress, `(${marketParams.baseAssetDecimals} dec)`);
  console.log("quote:", marketParams.quoteAssetAddress, `(${marketParams.quoteAssetDecimals} dec)`);
  console.log("pricePrecision:", marketParams.pricePrecision.toString());
  console.log("sizePrecision :", marketParams.sizePrecision.toString());
  console.log("tickSize      :", marketParams.tickSize.toString(), "=", ethers.utils.formatUnits(marketParams.tickSize, Number(Math.log10(marketParams.pricePrecision.toNumber()))), "mUSD");
  console.log("minSize       :", marketParams.minSize.toString(), "=", ethers.utils.formatUnits(marketParams.minSize, Number(Math.log10(marketParams.sizePrecision.toNumber()))), "mzNGN");
  console.log("maxSize       :", marketParams.maxSize.toString());
  console.log("takerFeeBps   :", marketParams.takerFeeBps.toString());
  console.log("makerFeeBps   :", marketParams.makerFeeBps.toString());

  // ------------------------------------------------------------- margin deposit
  console.log(`\n== 4) Margin deposits (fund the maker orders) ==`);
  console.log(`deposit ${cfg.LIST_MARGIN_QUOTE} MOCKUSD (quote) for the bid...`);
  const depQuote = await KuruSdk.MarginDeposit.deposit(
    signer, cfg.KURU_MARGIN_TESTNET, walletAddress,
    mockusdAddress, cfg.LIST_MARGIN_QUOTE, usdDecimals, true, TX_OPTIONS
  );
  console.log("  tx:", MONADLINK(depQuote.transactionHash));
  result.marginDepositQuoteTxHash = depQuote.transactionHash;

  console.log(`deposit ${cfg.LIST_MARGIN_BASE} mzNGN (base) for the ask...`);
  const depBase = await KuruSdk.MarginDeposit.deposit(
    signer, cfg.KURU_MARGIN_TESTNET, walletAddress,
    mzngnAddress, cfg.LIST_MARGIN_BASE, mzngnDecimals, true, TX_OPTIONS
  );
  console.log("  tx:", MONADLINK(depBase.transactionHash));
  result.marginDepositBaseTxHash = depBase.transactionHash;
  save();

  // ------------------------------------------------------------ maker orders
  console.log(`\n== 5) Post-only maker orders ==`);
  console.log(`BID  ${cfg.LIST_BID_SIZE} mzNGN @ ${cfg.LIST_BID_PRICE} mUSD (order id expected = bid)`);
  const bidReceipt = await KuruSdk.GTC.placeLimit(signer, marketAddress, marketParams, {
    price: cfg.LIST_BID_PRICE,
    size: cfg.LIST_BID_SIZE,
    isBuy: true,
    postOnly: true,
    txOptions: TX_OPTIONS,
  });
  const bidEvents = parseEvents(bidReceipt);
  if (!bidEvents.newOrderIds.length) throw new Error("Bid placed but no OrderCreated event found");
  const bidOrderId = bidEvents.newOrderIds[0];
  console.log("  tx     :", MONADLINK(bidReceipt.transactionHash));
  console.log("  orderId:", bidOrderId.toString());
  result.bidOrderId = bidOrderId.toString();
  result.bidTxHash = bidReceipt.transactionHash;
  save();

  console.log(`ASK   ${cfg.LIST_ASK_SIZE} mzNGN @ ${cfg.LIST_ASK_PRICE} mUSD`);
  const askReceipt = await KuruSdk.GTC.placeLimit(signer, marketAddress, marketParams, {
    price: cfg.LIST_ASK_PRICE,
    size: cfg.LIST_ASK_SIZE,
    isBuy: false,
    postOnly: true,
    txOptions: TX_OPTIONS,
  });
  const askEvents = parseEvents(askReceipt);
  if (!askEvents.newOrderIds.length) throw new Error("Ask placed but no OrderCreated event found");
  const askOrderId = askEvents.newOrderIds[0];
  console.log("  tx     :", MONADLINK(askReceipt.transactionHash));
  console.log("  orderId:", askOrderId.toString());
  result.askOrderId = askOrderId.toString();
  result.askTxHash = askReceipt.transactionHash;
  save();

  console.log("\n  Order book after maker orders:");
  const l2Before = await withRetry("l2book", () => KuruSdk.OrderBook.getL2OrderBook(provider, marketAddress, marketParams));
  console.log("  bids:", JSON.stringify(l2Before.bids.slice(0, 3)));
  console.log("  asks:", JSON.stringify(l2Before.asks.slice(0, 3)));
  if (!l2Before.bids.some(([p]) => p === Number(cfg.LIST_BID_PRICE))) {
    throw new Error("Bid not visible in L2 book - placement failed");
  }
  if (!l2Before.asks.some(([p]) => p === Number(cfg.LIST_ASK_PRICE))) {
    throw new Error("Ask not visible in L2 book - placement failed");
  }

  // ------------------------------------------------------------- taker order
  console.log(`\n== 6) Fill-or-kill taker market SELL ${cfg.LIST_TAKER_SELL_SIZE} mzNGN (min out ${cfg.LIST_TAKER_SELL_MIN_OUT} mUSD) ==`);
  // Snapshot the quote balance right before the taker order so the MOCKUSD gain
  // is measured against the true starting point (after top-ups + margin deposits).
  const usdPreSell = await mockusd.balanceOf(walletAddress);
  const sellReceipt = await KuruSdk.IOC.placeMarket(signer, marketAddress, marketParams, {
    approveTokens: true,
    isBuy: false,
    size: cfg.LIST_TAKER_SELL_SIZE,
    minAmountOut: cfg.LIST_TAKER_SELL_MIN_OUT,
    isMargin: false,
    fillOrKill: true,
    txOptions: TX_OPTIONS,
  });
  const sellEvents = parseEvents(sellReceipt);
  save();
  if (!sellEvents.trades.length) throw new Error("Market sell executed but no Trade event found in receipt");
  const sizeDecimals = Number(Math.log10(marketParams.sizePrecision.toNumber()));
  const priceDecimals = Number(Math.log10(marketParams.pricePrecision.toNumber()));
  result.trades = sellEvents.trades.map((t) => {
    // Kuru emits Trade price in 18-decimal "wei" scale; older builds used
    // pricePrecision scale. Detect whichever matches the order price.
    const as18 = ethers.utils.formatUnits(t.price, 18);
    const asPrec = ethers.utils.formatUnits(t.price, priceDecimals);
    const human = parseFloat(as18) === parseFloat(cfg.LIST_BID_PRICE) ? as18 : parseFloat(asPrec) === parseFloat(cfg.LIST_BID_PRICE) ? asPrec : `${as18} (?:${asPrec})`;
    return {
      orderId: t.orderId.toString(),
      priceRaw: t.price.toString(),
      priceHuman: human,
      filledSize: t.filledSize.toString(),
      // The Trade event's isBuy is the TAKER order's direction (verified
      // on-chain: a sell taker filling a maker bid emits isBuy=false).
      takerIsBuy: t.isBuy,
    };
  });
  console.log("sell tx   :", MONADLINK(sellReceipt.transactionHash));
  console.log("block     :", sellReceipt.blockNumber);
  console.log("Trade events (orderId = maker order filled; isBuy = taker direction):");
  for (const t of result.trades) {
    console.log(`  orderId=${t.orderId} price(raw)=${t.priceRaw} price=${t.priceHuman} filledSize=${t.filledSize} takerIsBuy=${t.takerIsBuy}`);
  }
  save();

  // ------------------------------------------------------------- verification
  console.log("\n== 7) On-chain verification ==");

  const l2After = await withRetry("l2book-after", () => KuruSdk.OrderBook.getL2OrderBook(provider, marketAddress, marketParams));
  console.log("Order book after trade:");
  console.log("  bids:", JSON.stringify(l2After.bids.slice(0, 3)));
  console.log("  asks:", JSON.stringify(l2After.asks.slice(0, 3)));

  const orderbook = new ethers.Contract(marketAddress, ORDERBOOK_ABI, provider);
  const [bidOrder, askOrder]: any[] = await Promise.all([
    withRetry("s_orders(bid)", () => orderbook.s_orders(bidOrderId.toNumber())),
    withRetry("s_orders(ask)", () => orderbook.s_orders(askOrderId.toNumber())),
  ]);
  console.log("maker bid struct (s_orders):");
  console.log("  owner:", bidOrder.ownerAddress, "| size(raw):", bidOrder.size.toString(), `= ${ethers.utils.formatUnits(bidOrder.size, sizeDecimals)} mzNGN | price(raw):`, bidOrder.price.toString(), "| isBuy:", bidOrder.isBuy);
  console.log("maker ask struct (s_orders):");
  console.log("  owner:", askOrder.ownerAddress, "| size(raw):", askOrder.size.toString(), `= ${ethers.utils.formatUnits(askOrder.size, sizeDecimals)} mzNGN | price(raw):`, askOrder.price.toString(), "| isBuy:", askOrder.isBuy);

  const usdAfter = await mockusd.balanceOf(walletAddress);
  const mzngnAfter = await mzngn.balanceOf(walletAddress);
  console.log("wallet MOCKUSD :", ethers.utils.formatUnits(usdAfter, usdDecimals));
  console.log("wallet mzNGN   :", ethers.utils.formatUnits(mzngnAfter, mzngnDecimals));

  // Assertions
  const expectedFilledRaw = ethers.utils.parseUnits(cfg.LIST_TAKER_SELL_SIZE, sizeDecimals);
  const totalFilledRaw = sellEvents.trades.reduce((a, t) => a.add(t.filledSize), BigNumber.from(0));
  if (!totalFilledRaw.eq(expectedFilledRaw)) {
    throw new Error(`Trade filled ${totalFilledRaw.toString()} of ${expectedFilledRaw.toString()} sizePrecision units`);
  }
  // The taker sold INTO the resting bid: the Trade event must reference the
  // bid order, and its isBuy (taker direction) must be false (taker = seller).
  if (result.trades.some((t) => t.orderId !== bidOrderId.toString() || t.takerIsBuy !== false)) {
    throw new Error("Expected taker sell to fill against the maker BID (orderId = bid, takerIsBuy=false)");
  }
  if (!result.trades.every((t) => t.priceHuman === cfg.LIST_BID_PRICE)) {
    throw new Error(`Trade price ${result.trades[0].priceHuman} != order price ${cfg.LIST_BID_PRICE}`);
  }
  // The maker bid should be left with 20 - 15 = 5 mzNGN resting.
  const expectedBidLeft = ethers.utils.parseUnits(
    (Number(cfg.LIST_BID_SIZE) - Number(cfg.LIST_TAKER_SELL_SIZE)).toString(),
    sizeDecimals
  );
  if (!bidOrder.size.eq(expectedBidLeft)) {
    throw new Error(`Resting bid size ${bidOrder.size.toString()} != expected ${expectedBidLeft.toString()}`);
  }
  // Taker must have received >= the min amount out as MOCKUSD credit.
  const quoteGainRaw = usdAfter.sub(usdPreSell);
  const minOutRaw = ethers.utils.parseUnits(cfg.LIST_TAKER_SELL_MIN_OUT, usdDecimals);
  if (quoteGainRaw.lt(minOutRaw)) {
    throw new Error(`MOCKUSD gained ${ethers.utils.formatUnits(quoteGainRaw, 6)} < minAmountOut ${cfg.LIST_TAKER_SELL_MIN_OUT}`);
  }
  console.log(`  taker MOCKUSD gain  : +${ethers.utils.formatUnits(quoteGainRaw, 6)} mUSD (min out ${cfg.LIST_TAKER_SELL_MIN_OUT})`);
  console.log(`  wallet mzNGN delta  : ${ethers.utils.formatUnits(mzngnAfter.sub(mzngnBal), 18)} (incl. any vault top-up)`);

  result.verification = {
    tradeBlock: sellReceipt.blockNumber,
    totalFilledRaw: totalFilledRaw.toString(),
    takerUsdGain: ethers.utils.formatUnits(quoteGainRaw, 6),
    restingBid: { sizeRaw: bidOrder.size.toString(), sizeHuman: ethers.utils.formatUnits(bidOrder.size, sizeDecimals), priceRaw: bidOrder.price.toString(), priceHuman: ethers.utils.formatUnits(bidOrder.price, priceDecimals), isBuy: bidOrder.isBuy },
    restingAsk: { sizeRaw: askOrder.size.toString(), priceRaw: askOrder.price.toString(), isBuy: askOrder.isBuy },
    l2Bids: l2After.bids.slice(0, 3),
    l2Asks: l2After.asks.slice(0, 3),
    walletMockusd: ethers.utils.formatUnits(usdAfter, 6),
    walletMzngn: ethers.utils.formatUnits(mzngnAfter, 18),
  };
  save();

  console.log("\n========================================================================");
  console.log("TASK 05 COMPLETE - mzNGN is listed on a real Kuru orderbook (Monad testnet)");
  console.log("  Market      :", ADDRLINK(marketAddress), "(MZNGN / MOCKUSD)");
  console.log("  Oracle      :", result.oraclePriceMusdPerBag, "mUSD/bag -> anchor", cfg.LIST_BID_PRICE, "mUSD/mzNGN");
  console.log("  Maker bid   :", cfg.LIST_BID_SIZE, "mzNGN @", cfg.LIST_BID_PRICE, "(orderId", bidOrderId.toString() + ",", "remaining", ethers.utils.formatUnits(bidOrder.size, sizeDecimals), "mzNGN)");
  console.log("  Maker ask   :", cfg.LIST_ASK_SIZE, "mzNGN @", cfg.LIST_ASK_PRICE, "(orderId", askOrderId.toString() + ")");
  console.log("  Taker sell  :", cfg.LIST_TAKER_SELL_SIZE, "mzNGN filled @", cfg.LIST_BID_PRICE, "mUSD -> +", ethers.utils.formatUnits(quoteGainRaw, 6), "mUSD");
  console.log("  Trade tx    :", MONADLINK(sellReceipt.transactionHash));
  console.log("  Deploy tx   :", marketTxHash ? MONADLINK(marketTxHash) : "(n/a)");
  console.log("  Result file :", RESULT_FILE, "(gitignored)");
  console.log("  Kuru UI     : no public testnet UI/explorer (kuru.io is mainnet-only); this market is");
  console.log("                verifiable on-chain via the tx/address links above and getL2Book reads.");
  console.log("========================================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nTASK05 FAILED:", e?.message || e);
    process.exit(1);
  });