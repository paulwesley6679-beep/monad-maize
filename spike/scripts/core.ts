/**
 * Core product (Task 02): mzNGN - oracle, collateral vault, and the full
 * mint/redeem loop, all on MONAD TESTNET (chain 10143).
 *
 * Sequence:
 *   1. preflight MON gas balance, check chain id
 *   2. deploy PriceOracle (authorized updater = this wallet, 48h staleness)
 *   3. deploy MockUSD (6 dec, owner-only mint) - same contract as the spike
 *   4. deploy MzngnToken (18 dec synthetic)
 *   5. deploy CollateralVault(oracle, token, mockusd); wire Vault into token
 *   6. publish the initial oracle price (50.00 mUSD / 100kg bag)
 *   7. mint: approve + deposit 150.00 mUSD -> assert exactly 2.0 mzNGN
 *   8. redeem: burn 1.0 mzNGN -> assert exactly 75.00 mUSD back (150% ratio)
 *   9. rejection tests (all must revert):
 *        - oracle update by a non-authorized wallet        (NotAuthorized)
 *        - oracle update with price 0                      (ZeroPrice)
 *        - oracle update moving +100% / -80% in one step   (TooLargeMove)
 *        - vault mint below the 1.00 mUSD minimum          (InsufficientCollateral)
 *        - vault mint without approving the vault          (allowance exceeded)
 *        - vault redeem of more mzNGN than held            (burn exceeds balance)
 *       plus a dedicated probe oracle with a 60s window whose getPrice()
 *       reverts once its price goes stale (proves the staleness guard on-chain
 *       without waiting 48h). Also: a +10% follow-up publish on that probe to
 *       show an in-band update succeeds.
 *
 * Re-runnability: set PRICE_ORACLE_ADDRESS / CORE_MOCKUSD_ADDRESS /
 * MZNGN_TOKEN_ADDRESS / COLLATERAL_VAULT_ADDRESS in .env to reuse deployed
 * contracts. setVault and initial price publish are skipped when already done.
 * Results are written to .core-result.json (gitignored).
 *
 * Usage: npm run core
 */
import { ethers } from "ethers";
import * as cfg from "../src/config";
import * as fs from "fs";
import * as path from "path";

const RESULT_FILE = path.join(__dirname, "..", ".core-result.json");
const MIN_MON_GAS = "0.05";

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

/**
 * Clamped tx overrides. The public Monad testnet RPC/gateway has quirks: it
 * sometimes suggests garbage fees (maxPriorityFeePerGas > maxFeePerGas) and
 * pre-reserves gasLimit * maxFee when a tx is submitted, rejecting the
 * broadcast as "insufficient balance" whenever that reserve exceeds the
 * wallet balance. Real deploy gas is ~0.5-0.65M (measured via eth_estimateGas
 * offline), so an 800k cap is generous for every operation here while keeping
 * the reserve (~0.0001 MON at a 115-130 gwei cap) affordable under any reserve
 * formula and making each broadcast cheap (~0.0001 MON) under any billing.
 */
async function makeTxOptions(provider: ethers.providers.JsonRpcProvider, balance: ethers.BigNumber) {
  const [feeData, block] = await Promise.all([
    withRetry("getFeeData", () => provider.getFeeData()),
    withRetry("latestBlock", () => provider.getBlock("latest")),
  ]);
  const baseFee = block.baseFeePerGas || ethers.BigNumber.from(100_000_000_000);
  const maxPriorityFeePerGas = ethers.BigNumber.from(2_000_000_000); // 2 gwei
  let maxFeePerGas = baseFee.mul(5).div(4).add(maxPriorityFeePerGas); // 1.25x base + priority
  const floor = ethers.BigNumber.from(115_000_000_000); // never below 115 gwei
  if (maxFeePerGas.lt(floor)) maxFeePerGas = floor;
  const gasLimit = ethers.BigNumber.from(800_000);
  const reserve = gasLimit.mul(maxFeePerGas);
  console.log(
    `tx fees : maxFee=${ethers.utils.formatUnits(maxFeePerGas, 9)} gwei, priority=${ethers.utils.formatUnits(maxPriorityFeePerGas, 9)} gwei ` +
      `(RPC suggested ${ethers.utils.formatUnits(feeData.maxFeePerGas || 0, 9)} gwei; reserve ${ethers.utils.formatEther(reserve)} MON)`
  );
  if (reserve.gt(balance)) {
    console.warn(`  WARN: gas reserve ${ethers.utils.formatEther(reserve)} MON exceeds the ${ethers.utils.formatEther(balance)} MON balance`);
  }
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas, type: 2 };
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

interface RejectionResult {
  label: string;
  expect: string;
  ok: boolean;
  detail: string;
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  const network = await withRetry("getNetwork", () => provider.getNetwork());
  console.log("== Network ==");
  console.log("chainId:", network.chainId, "(expect 10143)");
  if (network.chainId !== cfg.CHAIN_ID) throw new Error(`Unexpected chain ${network.chainId}`);
  console.log("block  :", await withRetry("getBlockNumber", () => provider.getBlockNumber()));

  const privateKey = cfg.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set in .env");
  const wallet = new ethers.Wallet(privateKey, provider);
  const walletAddress = wallet.address.toLowerCase();
  const signer = resilientSigner(wallet);
  const MONADLINK = (h: string) => `${cfg.EXPLORER}/tx/${h}`;
  const ADDRLINK = (a: string) => `${cfg.EXPLORER}/address/${a}`;
  console.log("wallet :", walletAddress);

  const skipMintRedeem = (process.env.CORE_SKIP_MINT_REDEEM || "").toLowerCase() === "1";
  const skipStaleProbe = (process.env.CORE_SKIP_STALE_PROBE || "").toLowerCase() === "1";
  // Low gas mode: when nothing broadcasts, relax the funding gate (all checks
  // below are eth_call simulations and reads, which cost no gas).
  const minMonGas = skipMintRedeem && skipStaleProbe ? "0.0005" : MIN_MON_GAS;
  const monBal = await withRetry("getBalance", () => wallet.getBalance());
  console.log("MON    :", ethers.utils.formatEther(monBal));
  if (monBal.lt(ethers.utils.parseEther(minMonGas))) {
    throw new Error(`Not enough MON for gas (need >= ${minMonGas}). Fund the wallet, then re-run.`);
  }
  // Clamped fee overrides (see makeTxOptions doc comment) - protects against
  // the public RPC's intermittent garbage fee suggestions.
  const TX_OPTIONS = await makeTxOptions(provider, monBal);

  const result: Record<string, any> = { wallet: walletAddress, chainId: network.chainId, rejections: [] };
  const save = () => fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  // ---------------------------------------------------------------- 1) oracle
  const oracleArtifact = readArtifact("PriceOracle");
  let oracleAddress = (process.env.PRICE_ORACLE_ADDRESS || "").toLowerCase();
  let oracle: ethers.Contract;
  if (oracleAddress) {
    console.log("\n== PriceOracle (reusing PRICE_ORACLE_ADDRESS) ==");
    oracle = new ethers.Contract(oracleAddress, oracleArtifact.abi, signer);
  } else {
    console.log("\n== 1) Deploy PriceOracle ==");
    const f = new ethers.ContractFactory(oracleArtifact.abi, oracleArtifact.bytecode, signer);
    const staleness = Number(cfg.CORE_ORACLE_STALENESS_HOURS) * 3600;
    const d = await f.deploy(walletAddress, staleness, TX_OPTIONS);
    await d.deployTransaction.wait(1);
    oracleAddress = d.address.toLowerCase();
    oracle = d;
    result.oracle = { address: oracleAddress, deployTxHash: d.deployTransaction.hash, updater: walletAddress, stalenessWindowSeconds: staleness };
    console.log("oracle :", ADDRLINK(oracleAddress));
    console.log("tx     :", MONADLINK(d.deployTransaction.hash));
  }
  console.log("updater:", await oracle.authorizedUpdater());
  console.log("window :", (await oracle.stalenessWindow()).toString(), "sec");

  // ---------------------------------------------------------------- 2) mockusd
  const mockusdArtifact = readArtifact("MockUSD");
  let mockusdAddress = (process.env.CORE_MOCKUSD_ADDRESS || "").toLowerCase();
  let mockusd: ethers.Contract;
  if (mockusdAddress) {
    console.log("\n== MockUSD (reusing CORE_MOCKUSD_ADDRESS) ==");
    mockusd = new ethers.Contract(mockusdAddress, mockusdArtifact.abi, signer);
  } else {
    console.log("\n== 2) Deploy MockUSD collateral (6 decimals, owner mint) ==");
    const f = new ethers.ContractFactory(mockusdArtifact.abi, mockusdArtifact.bytecode, signer);
    const d = await f.deploy(ethers.utils.parseUnits("1000000", 6), TX_OPTIONS);
    await d.deployTransaction.wait(1);
    mockusdAddress = d.address.toLowerCase();
    mockusd = d;
    result.mockusd = { address: mockusdAddress, deployTxHash: d.deployTransaction.hash };
    console.log("mockusd:", ADDRLINK(mockusdAddress));
    console.log("tx     :", MONADLINK(d.deployTransaction.hash));
  }
  const usdDecimals = Number(await mockusd.decimals());
  if (usdDecimals !== 6) throw new Error(`MockUSD decimals ${usdDecimals}, expected 6`);

  // Mint MOCKUSD to the wallet if short (deposit + buffer).
  const usdBal = await mockusd.balanceOf(walletAddress);
  const minUsd = ethers.utils.parseUnits(cfg.CORE_MINT_DEPOSIT_MUSD, 6);
  if (usdBal.lt(minUsd)) {
    const m = await mockusd.connect(signer).mint(walletAddress, ethers.utils.parseUnits(cfg.CORE_MOCKUSD_MINT_TO_SELF, 6), TX_OPTIONS);
    const r = await m.wait(1);
    console.log("mockusd mint tx:", MONADLINK(r.transactionHash));
  } else {
    console.log("MOCKUSD balance >= deposit need, skipping mint");
  }

  // ---------------------------------------------------------------- 3) mzngn token
  const mzngnArtifact = readArtifact("MzngnToken");
  let mzngnAddress = (process.env.MZNGN_TOKEN_ADDRESS || "").toLowerCase();
  let mzngn: ethers.Contract;
  if (mzngnAddress) {
    console.log("\n== MzngnToken (reusing MZNGN_TOKEN_ADDRESS) ==");
    mzngn = new ethers.Contract(mzngnAddress, mzngnArtifact.abi, signer);
  } else {
    console.log("\n== 3) Deploy MzngnToken (18 decimals) ==");
    const f = new ethers.ContractFactory(mzngnArtifact.abi, mzngnArtifact.bytecode, signer);
    const d = await f.deploy(TX_OPTIONS);
    await d.deployTransaction.wait(1);
    mzngnAddress = d.address.toLowerCase();
    mzngn = d;
    result.mzngn = { address: mzngnAddress, deployTxHash: d.deployTransaction.hash };
    console.log("mzngn  :", ADDRLINK(mzngnAddress));
    console.log("tx     :", MONADLINK(d.deployTransaction.hash));
  }

  // ---------------------------------------------------------------- 4) vault
  const vaultArtifact = readArtifact("CollateralVault");
  let vaultAddress = (process.env.COLLATERAL_VAULT_ADDRESS || "").toLowerCase();
  let vault: ethers.Contract;
  if (vaultAddress) {
    console.log("\n== CollateralVault (reusing COLLATERAL_VAULT_ADDRESS) ==");
    vault = new ethers.Contract(vaultAddress, vaultArtifact.abi, signer);
  } else {
    console.log("\n== 4) Deploy CollateralVault ==");
    const f = new ethers.ContractFactory(vaultArtifact.abi, vaultArtifact.bytecode, signer);
    const d = await f.deploy(oracleAddress, mzngnAddress, mockusdAddress, TX_OPTIONS);
    await d.deployTransaction.wait(1);
    vaultAddress = d.address.toLowerCase();
    vault = d;
    result.vault = { address: vaultAddress, deployTxHash: d.deployTransaction.hash };
    console.log("vault  :", ADDRLINK(vaultAddress));
    console.log("tx     :", MONADLINK(d.deployTransaction.hash));
  }

  // Wire the vault into the token (once).
  const curVault = await mzngn.vault();
  if (curVault.toLowerCase() !== vaultAddress) {
    const t = await mzngn.connect(signer).setVault(vaultAddress, TX_OPTIONS);
    const r = await t.wait(1);
    result.vaultSetTxHash = r.transactionHash;
    console.log("vault set tx:", MONADLINK(r.transactionHash));
  } else {
    console.log("token vault already set, skipping");
  }

  // ---------------------------------------------------------------- 5) initial price
  console.log("\n== 5) Publish initial oracle price ==");
  const initialPrice = ethers.utils.parseUnits(cfg.CORE_INITIAL_PRICE_MUSD, 6);
  if ((await oracle.price()).eq(0)) {
    const t = await oracle.connect(signer).updatePrice(initialPrice, cfg.CORE_INITIAL_SOURCE, TX_OPTIONS);
    const r = await t.wait(1);
    result.initialPricePublishTxHash = r.transactionHash;
    console.log("price  :", cfg.CORE_INITIAL_PRICE_MUSD, "mUSD/bag (", initialPrice.toString(), ")");
    console.log("tx     :", MONADLINK(r.transactionHash));
  } else {
    console.log("price already published:", ethers.utils.formatUnits(await oracle.price(), 6), "(skipping)");
  }
  const read = await oracle.getPrice();
  console.log("getPrice ->", ethers.utils.formatUnits(read[0], 6), "mUSD/bag, updatedAt", read[1].toString(), ", source", read[2]);

  // ---------------------------------------------------------------- 6) mint
  // CORE_SKIP_MINT_REDEEM=1 skips the (already proven) on-chain mint/redeem
  // loop - used for gas-free verification runs when the test wallet is low on
  // MON. The rejection harness below is pure eth_call simulation (no gas).
  const mintAndRedeem = async () => {
  console.log("\n== 6) Mint: deposit", cfg.CORE_MINT_DEPOSIT_MUSD, "mUSD -> expect 2.0 mzNGN @ 50.00 ==");
  const deposit = ethers.utils.parseUnits(cfg.CORE_MINT_DEPOSIT_MUSD, 6);
  const previewMint = await vault.getMintPreview(deposit);
  console.log("getMintPreview:", previewMint.toString(), "raw =", ethers.utils.formatUnits(previewMint, 18), "mzNGN (expect 2.0)");
  const expectedMinted = ethers.utils.parseUnits("2", 18);
  if (!previewMint.eq(expectedMinted)) {
    throw new Error(`Mint preview ${previewMint.toString()} != expected ${expectedMinted.toString()}`);
  }

  const usdBeforeMint = await mockusd.balanceOf(walletAddress);
  const mzngnBeforeMint = await mzngn.balanceOf(walletAddress);
  const appr = await mockusd.connect(signer).approve(vaultAddress, deposit, TX_OPTIONS);
  await appr.wait(1);
  const mintTx = await vault.connect(signer).mint(deposit, TX_OPTIONS);
  const mintReceipt = await mintTx.wait(1);
  result.mint = {
    deposit: deposit.toString(),
    preview: previewMint.toString(),
    txHash: mintReceipt.transactionHash,
  };
  console.log("mint tx :", MONADLINK(mintReceipt.transactionHash));

  const usdAfterMint = await mockusd.balanceOf(walletAddress);
  const mzngnAfterMint = await mzngn.balanceOf(walletAddress);
  if (!mzngnAfterMint.sub(mzngnBeforeMint).eq(expectedMinted)) {
    throw new Error(`Minted ${mzngnAfterMint.sub(mzngnBeforeMint).toString()} != expected 2e18`);
  }
  if (!usdBeforeMint.sub(usdAfterMint).eq(deposit)) {
    throw new Error("mUSD not reduced by exactly the deposit");
  }
  console.log("  mzNGN delta  :", ethers.utils.formatUnits(mzngnAfterMint.sub(mzngnBeforeMint), 18), "(expect 2.0)");
  console.log("  mUSD delta   :", -ethers.utils.formatUnits(usdBeforeMint.sub(usdAfterMint), 6), "(expect -150.00)");

  // ---------------------------------------------------------------- 7) redeem
  console.log("\n== 7) Redeem: burn 1.0 mzNGN -> expect 75.00 mUSD back (150% ratio) ==");
  const burnAmount = ethers.utils.parseUnits(cfg.CORE_REDEEM_MZNGN, 18);
  const previewRedeem = await vault.getRedeemPreview(burnAmount);
  console.log("getRedeemPreview:", previewRedeem.toString(), "raw =", ethers.utils.formatUnits(previewRedeem, 6), "mUSD (expect 75.0)");
  const expectedPayout = ethers.utils.parseUnits("75", 6);
  if (!previewRedeem.eq(expectedPayout)) {
    throw new Error(`Redeem preview ${previewRedeem.toString()} != expected ${expectedPayout.toString()}`);
  }

  const usdBeforeRedeem = await mockusd.balanceOf(walletAddress);
  const mzngnBeforeRedeem = await mzngn.balanceOf(walletAddress);
  const redeemTx = await vault.connect(signer).redeem(burnAmount, TX_OPTIONS);
  const redeemReceipt = await redeemTx.wait(1);
  result.redeem = {
    burn: burnAmount.toString(),
    preview: previewRedeem.toString(),
    txHash: redeemReceipt.transactionHash,
  };
  console.log("redeem tx:", MONADLINK(redeemReceipt.transactionHash));

  const usdAfterRedeem = await mockusd.balanceOf(walletAddress);
  const mzngnAfterRedeem = await mzngn.balanceOf(walletAddress);
  if (!mzngnBeforeRedeem.sub(mzngnAfterRedeem).eq(burnAmount)) {
    throw new Error("mzNGN not reduced by exactly the burned amount");
  }
  if (!usdAfterRedeem.sub(usdBeforeRedeem).eq(expectedPayout)) {
    throw new Error(`mUSD payout ${usdAfterRedeem.sub(usdBeforeRedeem).toString()} != expected 75e6`);
  }
  console.log("  mzNGN delta  :", -ethers.utils.formatUnits(mzngnBeforeRedeem.sub(mzngnAfterRedeem), 18), "(expect -1.0)");
  console.log("  mUSD delta   :", ethers.utils.formatUnits(usdAfterRedeem.sub(usdBeforeRedeem), 6), "(expect +75.00)");

  const endUsd = await mockusd.balanceOf(walletAddress);
  const usdInVault = await mockusd.balanceOf(vaultAddress);
  console.log("\n  wallet mUSD:", ethers.utils.formatUnits(endUsd, 6), "| vault mUSD:", ethers.utils.formatUnits(usdInVault, 6));
  };
  if (skipMintRedeem) {
    console.log("\n== 6+7) Mint/redeem loop SKIPPED (CORE_SKIP_MINT_REDEEM=1; already proven on-chain) ==");
  } else {
    await mintAndRedeem();
  }

  // ---------------------------------------------------------------- 8) rejections
  console.log("\n== 8) Rejection tests (each must revert) ==");
  const randomWallet = ethers.Wallet.createRandom();
  const priceNow = (await oracle.price()).toString();

  /**
   * Simulate a call with eth_call (read-only; no broadcast) and decide whether
   * it reverts. Two node behaviors are handled:
   *   - standard nodes THROW when the simulated call reverts;
   *   - the Monad public testnet RPC instead RETURNS the 4-byte custom-error
   *     selector (or Error(string) data) as a "successful" result.
   * Either way a revert is detected: a successful ABI result for every
   * function exercised here is 32-byte aligned (uint256 / tuples of uint256),
   * while revert data never is (4-byte selectors, or 0x08c379a0/0x4e487b71
   * frames). Thrown calls are reverts unless the RPC itself flaked.
   */
  async function expectRevert(
    label: string,
    expect: string,
    contract: ethers.Contract,
    fn: string,
    args: any[],
    from?: string
  ): Promise<void> {
    const data = contract.interface.encodeFunctionData(fn, args);
    let res: string;
    try {
      res = await provider.call({ to: contract.address, from: from || walletAddress, data });
    } catch (e: any) {
      if (e?.code === "SERVER_ERROR" || e?.code === "TIMEOUT") {
        const detail = String(e?.message || e).slice(0, 200);
        result.rejections.push({ label, expect, ok: false, detail: `RPC flake: ${detail}` });
        console.log(`  [FAIL] ${label}: RPC flake (expect: ${expect})`);
        console.log(`        detail: ${detail}`);
        return;
      }
      const detail = String(e?.reason || e?.message || e).slice(0, 200);
      result.rejections.push({ label, expect, ok: true, detail });
      console.log(`  [ok] ${label}: reverted (expect: ${expect})`);
      return;
    }
    const hexLen = res.length - 2; // hex digits after "0x"
    const revertShaped = hexLen % 64 !== 0; // 32-byte aligned = real ABI result
    if (revertShaped) {
      result.rejections.push({ label, expect, ok: true, detail: `revert data: ${res}` });
      console.log(`  [ok] ${label}: reverted (expect: ${expect})`);
    } else {
      result.rejections.push({ label, expect, ok: false, detail: "NO REVERT - eth_call succeeded" });
      console.log(`  [FAIL] ${label}: expected revert (${expect}), but eth_call succeeded`);
    }
  }

  // a. unauthorized updater (msg.sender = some random wallet)
  await expectRevert(
    "oracle-unauthorized",
    "NotAuthorized",
    oracle,
    "updatePrice",
    [priceNow, "evil"],
    randomWallet.address
  );
  // b. zero price
  await expectRevert("oracle-zero-price", "ZeroPrice", oracle, "updatePrice", [0, "zero"]);
  // c. wild move +100% in one step
  const priceDoubled = ethers.BigNumber.from(priceNow).mul(2).toString();
  await expectRevert("oracle-wild-up", "TooLargeMove", oracle, "updatePrice", [priceDoubled, "wild up"]);
  // d. wild move -80% in one step
  const priceEightyPctDown = ethers.BigNumber.from(priceNow).mul(2).div(10).toString();
  await expectRevert("oracle-wild-down", "TooLargeMove", oracle, "updatePrice", [priceEightyPctDown, "wild down"]);
  // e. mint below the minimum collateral (0.50 mUSD < 1.00 mUSD min)
  await expectRevert("vault-mint-below-min", "InsufficientCollateral", vault, "mint", [
    ethers.utils.parseUnits("0.5", 6),
  ]);
// f. mint with no allowance: a fresh caller (no allowance, no mUSD) attempting
//    a 30 mUSD mint - MockUSD.transferFrom reverts on the missing allowance
//    (simulation only; no state change, no extra txs).
  await expectRevert(
    "vault-mint-no-allowance",
    "MockUSD: allowance exceeded",
    vault,
    "mint",
    [ethers.utils.parseUnits("30", 6)],
    randomWallet.address
  );
  // g. over-redeem: burn one more mzNGN than the wallet holds
  const heldMzngn = await mzngn.balanceOf(walletAddress);
  console.log(`  (wallet holds ${ethers.utils.formatUnits(heldMzngn, 18)} mzNGN; attempting redeem of +1)`);
  await expectRevert("vault-over-redeem", "mzNGN: burn exceeds balance", vault, "redeem", [
    heldMzngn.add(1),
  ]);

  // ---------------------------------------------------------------- 9) stale probe
  const staleProbe = (process.env.CORE_SKIP_STALE_PROBE || "").toLowerCase();
  if (staleProbe !== "1") {
    console.log("\n== 9) Staleness proof: probe oracle with a 60s window ==");
    const f = new ethers.ContractFactory(oracleArtifact.abi, oracleArtifact.bytecode, signer);
    const probe = await f.deploy(walletAddress, cfg.CORE_STALE_PROBE_WINDOW_SECONDS, TX_OPTIONS);
    await probe.deployTransaction.wait(1);
    result.staleProbe = { address: probe.address.toLowerCase(), deployTxHash: probe.deployTransaction.hash };
    console.log("probe  :", ADDRLINK(probe.address.toLowerCase()));
    console.log("tx     :", MONADLINK(probe.deployTransaction.hash));

    // in-band follow-up publish (+10%) must succeed
    const pub1 = await probe.connect(signer).updatePrice(initialPrice, "probe-1", TX_OPTIONS);
    const pub1r = await pub1.wait(1);
    const pub2 = await probe.connect(signer).updatePrice(ethers.utils.parseUnits("55.00", 6), "probe-2", TX_OPTIONS);
    const pub2r = await pub2.wait(1);
    const freshRead = await probe.getPrice();
    console.log("probe +10% update tx:", MONADLINK(pub2r.transactionHash));
    console.log("fresh read ok: price =", ethers.utils.formatUnits(freshRead[0], 6), "(proves +10% in-band accepted)");

    const waitSec = cfg.CORE_STALE_PROBE_WINDOW_SECONDS + 25;
    console.log(`waiting ${waitSec}s so the probe price goes stale (> ${cfg.CORE_STALE_PROBE_WINDOW_SECONDS}s)...`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));

    await expectRevert("oracle-stale-read", "StalePrice", probe, "getPrice", []);
    result.staleProbe.initialPublishTxHash = pub1r.transactionHash;
    result.staleProbe.followUpTxHash = pub2r.transactionHash;
  } else {
    console.log("\n== 9) Staleness probe skipped (CORE_SKIP_STALE_PROBE=1) ==");
  }

  // ---------------------------------------------------------------- results
  result.verification = {
    walletUsd: ethers.utils.formatUnits(await mockusd.balanceOf(walletAddress), 6),
    vaultUsd: ethers.utils.formatUnits(await mockusd.balanceOf(vaultAddress), 6),
    walletMzngn: ethers.utils.formatUnits(await mzngn.balanceOf(walletAddress), 18),
    oraclePrice: ethers.utils.formatUnits(await oracle.price(), 6),
  };
  save();

  const failures = result.rejections.filter((r: RejectionResult) => !r.ok);
  console.log("\n========================================================================");
  console.log("CORE CONTRACTS COMPLETE (Monad testnet)");
  console.log("  PriceOracle     :", ADDRLINK(oracleAddress));
  console.log("  MockUSD         :", ADDRLINK(mockusdAddress));
  console.log("  MzngnToken      :", ADDRLINK(mzngnAddress));
  console.log("  CollateralVault :", ADDRLINK(vaultAddress));
  console.log("  mint tx         :", result.mint?.txHash ? MONADLINK(result.mint.txHash) : "(n/a)");
  console.log("  redeem tx       :", result.redeem?.txHash ? MONADLINK(result.redeem.txHash) : "(n/a)");
  console.log("  rejections      :", result.rejections.length, "attempted,", result.rejections.length - failures.length, "reverted as expected");
  if (failures.length) {
    console.log("  FAILED REJECTIONS:", failures.map((f: RejectionResult) => f.label).join(", "));
  }
  console.log("  result file     :", RESULT_FILE);
  console.log("========================================================================\n");
  if (failures.length > 0) throw new Error(`${failures.length} rejection test(s) did not revert`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nCORE FAILED:", e?.message || e);
    process.exit(1);
  });