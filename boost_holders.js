require('dotenv').config();
const bs58 = require('bs58');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const { PinPetSdk, getDefaultOptions, SPINPET_PROGRAM_ID } = require('pinpet-sdk');
const anchor = require('@coral-xyz/anchor');
const Decimal = require('decimal.js');
const fs = require('fs');
const path = require('path');

const config = {
    network: process.env.NETWORK || "LOCALNET",
    rpc: process.env.RPC || "http://47.109.157.92:8899",
    mintAddress: process.env.MINT_ADDRESS || "",
    totalTargetCount: Number(process.env.SUBWALLET_COUNT_FOR_HOLDER) || 5000,
    minAmountForHolder: parseFloat(process.env.MIN_AMOUNT_FOR_HOLDER) || 0.03,
    maxAmountForHolder: parseFloat(process.env.MAX_AMOUNT_FOR_HOLDER) || 0.05,
    mnemonic: process.env.MNEMONIC_FOR_HOLDER,
    minDelay: Number(process.env.MIN_DELAY) || 3000,
    maxDelay: Number(process.env.MAX_DELAY) || 10000,
};
const CHECKPOINT_FILE = path.join(__dirname, 'checkpoint.json');

function getCheckpoint() {
    const filePath = CHECKPOINT_FILE;
    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data).currentIndex || 0;
    }
    return 0; 
}

function saveCheckpoint(newIndex) {
    const filePath = CHECKPOINT_FILE;
    const existingData = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : {};
    const updatedData = {
        ...existingData,
        currentIndex: newIndex
    };
    fs.writeFileSync(filePath, JSON.stringify(updatedData, null, 2));
}

function recordFailedIndex(index) {
    const filePath = CHECKPOINT_FILE;
    let data = {};
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            data = JSON.parse(content || '{}');
        }
        if (!Array.isArray(data.failedIndices)) {
            data.failedIndices = [];
        }
        if (!data.failedIndices.includes(index)) {
            data.failedIndices.push(index);
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`子钱包 #${index} 已加入交易失败列表。以便后续处理`);

    } catch (err) {
        console.error("记录失败序号时出错:", err.message);
    }
}

async function generateChildWallets(mnemonic, fromIndex, count) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("无效的助记词");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const seedHex = seed.toString('hex');
    const wallets = [];
    
    console.log(`从序号 ${fromIndex} 开始生成钱包, 数量 ${count}\n`);
    for (let i = fromIndex; i < fromIndex + count; i++) {
        const path = `m/44'/501'/${i}'/0'`;
        const derivedSeed = derivePath(path, seedHex).key;
        const keypair = Keypair.fromSeed(derivedSeed);
        wallets.push({
            keypair,
            index: i,
        });
        console.log(`[钱包 #${i}] 地址: ${keypair.publicKey.toBase58()} 私钥：${bs58.encode(keypair.secretKey)}`);
    }
    console.log(`\n... 成功生成 ${wallets.length} 个钱包地址。序号 ${fromIndex} - ${fromIndex+count-1}`);
    return wallets;
}

async function distributeRandomAmounts(connection, mainWallet, subWallets) {
    let walletsWithAmount = [];
    for (let i = 0; i < subWallets.length; i++) {
        // 生成随机金额：保留 4 位精度
        const randomAmount = new Decimal(Math.random())
            .mul(config.maxAmountForHolder - config.minAmountForHolder)
            .plus(config.minAmountForHolder)
            .toDecimalPlaces(4, Decimal.ROUND_DOWN)
            .toNumber();
        walletsWithAmount.push({
            address: subWallets[i].keypair.publicKey,
            amount: randomAmount
        });
    }
    const transaction = new Transaction();
    walletsWithAmount.forEach(wallet => {
        transaction.add(
            SystemProgram.transfer({
                fromPubkey: mainWallet.publicKey,
                toPubkey: wallet.address,
                lamports: Math.floor(wallet.amount * LAMPORTS_PER_SOL),
            })
        );
    });   
    
    try {
        const signature = await sendAndConfirmTransaction(
            connection, 
            transaction, 
            [mainWallet]
        );
        console.log(`子钱包序号 #${subWallets[0].index} 到 #${subWallets[subWallets.length - 1].index} 分发成功! Hash: ${signature}`);
        return true;

    } catch (err) {
        console.error(`子钱包序号 #${subWallets[0].index} 到 #${subWallets[subWallets.length - 1].index} 分发失败! ${err.message}`);
        return false;
    }
}

/**
 * 现货买入
 */
 async function executeBuy(wallet, id, mintAddress, buyAmount, connection, sdk) {
    const simResult = await sdk.simulator.simulateBuy(mintAddress, BigInt(buyAmount));
    console.log(simResult);
    if (!simResult.success || !simResult.data ) {
        throw new Error(`simulateBuy 失败: ${simResult.errorMessage}`);
    }
    const idealTokenAmount = simResult.data.idealTokenAmount;
    const idealTokenDecimal = new Decimal(idealTokenAmount.toString());
    if (idealTokenDecimal.lt(new Decimal('1000000000'))) {
        throw new Error(`simulateBuy 失败: 买入量不足一个代币`);
    }
    const maxSolAmount = new Decimal(buyAmount)
        .mul(new Decimal(1).add(new Decimal(1).div(100)))
        .ceil();
    const result = await sdk.trading.buy({
        mintAccount: mintAddress,
        buyTokenAmount: new anchor.BN(idealTokenDecimal.toFixed(0)), 
        maxSolAmount: new anchor.BN(maxSolAmount.toFixed(0)),
        payer: wallet.publicKey
    });
    result.transaction.feePayer = wallet.publicKey;
    result.transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    result.transaction.sign(wallet);
    const signature = await connection.sendRawTransaction(result.transaction.serialize());
    await connection.confirmTransaction(signature);
    console.log(`✅ 子钱包 #${id} 买入成功 ${signature}`);
}

async function executeBatchBuy(connection, wallets, mintAddress) {
    const options = getDefaultOptions(config.network);
    const sdk = new PinPetSdk(connection, SPINPET_PROGRAM_ID, options);
    console.log(`开始批量购买。子钱包序号: #${wallets[0].index} - #${wallets[wallets.length - 1].index}`);
    for (const wallet of wallets) {
        try {
            const balance = await connection.getBalance(wallet.keypair.publicKey);
            const gasBuffer = 0.006 * LAMPORTS_PER_SOL; // 预留 0.006 SOL 手续费
            if (balance <= gasBuffer) {
                console.log(`[跳过] 余额不足以支付 Gas: ${balance / LAMPORTS_PER_SOL} SOL`);
            }  else {
                const buyAmount = balance - gasBuffer;
                console.log(`[BUY] 投入金额: ${(buyAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL`);    
                await executeBuy(wallet.keypair, wallet.index, mintAddress, buyAmount, connection, sdk);
            }

        } catch (err) {
            console.error(`❌ 子钱包 #${wallet.index} 买入失败: ${err.message}`);
            recordFailedIndex(wallet.index);
        }
        const nextWait = Math.floor(Math.random() * (config.maxDelay - config.minDelay)) + config.minDelay;
        console.log(`[等待] ${nextWait / 1000} 秒后进行下一次操作...`);
        await new Promise(resolve => setTimeout(resolve, nextWait));
    }
    saveCheckpoint(wallets[wallets.length - 1].index + 1);
    console.log(`批量购买完成。子钱包序号: #${wallets[0].index} - #${wallets[wallets.length - 1].index}`);
}

let isPendingExit = false;
let isSleeping = false;

process.on('SIGINT', () => {
    if (isSleeping) {
        // 如果批处理间隙休眠状态，直接安全退出
        console.log("\n[状态: 休眠中] 检测到 Ctrl-C，正在安全退出...");
        process.exit(0);
    } else {
        // 如果正在执行交易，标记isPendingExit为True, 不打断当前操作
        console.log("\n[状态: 执行交易中] 检测到 Ctrl-C。为保持数据完整性和一致性，将在本组交易完成后自动退出...");
        isPendingExit = true; 
    }
});

async function run() {
    const connection = new Connection(config.rpc, "confirmed");
    const privateKeyString = process.env.MAIN_WALLET_PRIVATE_KEY_FOR_HOLDER;
    if (!privateKeyString) {
        console.error("未找到环境变量 MAIN_WALLET_PRIVATE_KEY，请检查 .env 文件");
        process.exit(1);
    }
    const secretKey = bs58.decode(privateKeyString);
    const mainWallet = Keypair.fromSecretKey(secretKey);
    console.log(`✅ 成功加载主钱包: ${mainWallet.publicKey.toBase58()}`);

    // 每次整批处理20个，包括生成钱包、分配金额、买入操作、记录已处理子钱包序号。
    const BATCH_SIZE = 20;  
    const currentIndex = getCheckpoint();
    console.log(`[启动] 当前断点序号: ${currentIndex}，从此处继续...`);
    for (let i = currentIndex; i < config.totalTargetCount; i += BATCH_SIZE) {
        const subWallets = await generateChildWallets(config.mnemonic, i, BATCH_SIZE);
        if (!await distributeRandomAmounts(connection, mainWallet, subWallets)) {
            console,log("检查主钱包余额是否不足，充值后重新启动程序");
            process.exit(0);
        }
        await executeBatchBuy(connection, subWallets, config.mintAddress);
        
        // 整批处理完后检查用户是否按下了Ctrl-C, 是则退出不再继续
        if (isPendingExit) {
            console.log("[安全退出] 本批交易已完成，检测到 Ctrl-C, 正在退出。");
            process.exit(0);
        }
        // 每处理完一批，休息10秒，此时按Ctrl-C 直接退出
        isSleeping = true; 
        await new Promise(resolve => setTimeout(resolve, 10000));
        isSleeping = false; 
    }
}

run();
