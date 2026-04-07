require('dotenv').config();
const bs58 = require('bs58');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { PinPetSdk, getDefaultOptions, SPINPET_PROGRAM_ID } = require('pinpet-sdk');
const anchor = require('@coral-xyz/anchor');
const Decimal = require('decimal.js');
const { 
    createCloseAccountInstruction, 
    getAssociatedTokenAddressSync, 
    TOKEN_PROGRAM_ID 
} = require('@solana/spl-token');
const { 
    Keypair,
    Connection,
    PublicKey,
    Transaction,
    SystemProgram, 
    LAMPORTS_PER_SOL, 
    sendAndConfirmTransaction 
} = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

// 配置参数读取.env
const config = {
    mintAddress: process.env.MINT_ADDRESS || "",
    network: process.env.NETWORK || "LOCALNET",
    rpc: process.env.RPC || "http://47.109.157.92:8899",
    mnemonic: process.env.MNEMONIC_FOR_HOLDER,
};
const CHECKPOINT_FILE = path.join(__dirname, 'checkpoint.json');

function getCheckpoint() {
    const filePath = CHECKPOINT_FILE;
    if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8') || '{}');
        return {
            currentIndex: data.currentIndex ?? 0,
            currentSweptIndex: data.currentSweptIndex ?? 0,
        }
    }
    return { currentIndex: 0, currentSwpetIndex: 0 }
}

function saveCheckpoint(newIndex) {
    const filePath = CHECKPOINT_FILE;
    const existingData = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : {};
    const updatedData = {
        ...existingData,
        currentSweptIndex: newIndex
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
        if (!Array.isArray(data.failedSweepIndices)) {
            data.failedSweepIndices = [];
        }
        if (!data.failedSweepIndices.includes(index)) {
            data.failedSweepIndices.push(index);
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`子钱包 #${index} 已加入归集失败列表。以便后续处理`);

    } catch (err) {
        console.error("记录归集失败序号时出错:", err.message);
    }
}

async function generateChildWallets(mnemonic, startIndex, endIndex) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("无效的助记词");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const seedHex = seed.toString('hex');
    const wallets = [];

    console.log(`开始生成 ${endIndex - startIndex} 个钱包...\n`);
    for (let i = startIndex; i < endIndex; i++) {
        const path = `m/44'/501'/${i}'/0'`;
        const derivedSeed = derivePath(path, seedHex).key;
        const keypair = Keypair.fromSeed(derivedSeed);
        wallets.push({
            keypair,
            index: i,
        });
        console.log(`子钱包 #${i} 地址: ${keypair.publicKey.toBase58()} 私钥：${bs58.encode(keypair.secretKey)}`);
    }

    console.log(`\n... 成功生成 ${wallets.length} 个钱包地址。`);
    return wallets;
}

async function sweepWallet(connection, subWallet, id, mainWalletPublicKey, mintAddress, sdk) {
    try {
        console.log(`开始归集子钱包 #${id} ...`);
        // 卖出所有代币 
        const tokenBalance = await getTokenBalance(connection, subWallet.publicKey, mintAddress);
        console.log("tokenBalance:", tokenBalance);
        if (tokenBalance > 0n) {
            console.log(`检测到余额 ${tokenBalance.toString()}，执行 Sell...`);
            await executeSell(subWallet, id, mintAddress, tokenBalance, connection, sdk);
        }

        // 关闭 ATA 账户指令 (回收约 0.002 SOL)
        const ata = getAssociatedTokenAddressSync(new PublicKey(mintAddress), subWallet.publicKey);
        const accountInfo = await connection.getAccountInfo(ata);
        if (accountInfo === null) {
            console.log(`[跳过] ATA 账户不存在，无需关闭: ${ata.toBase58()}`);
        } else {
            const balanceResponse = await connection.getTokenAccountBalance(ata, 'confirmed');
            const actualRawAmount = BigInt(balanceResponse.value.amount);
            if (actualRawAmount > 0n) {
                console.warn(`检测到残留碎屑: ${actualRawAmount.toString()}，跳过关闭 ATA 以免报错。`);
            } else {
                const transaction = new Transaction().add(
                    createCloseAccountInstruction(
                        ata,
                        mainWalletPublicKey,
                        subWallet.publicKey,
                        []
                    )
                );
                console.log(`执行关闭 ATA 指令: ${ata.toBase58()}`);
                await sendAndConfirmTransaction(connection, transaction, [subWallet]);
            }
        }
    
        // 2. 转移剩余所有 SOL
        // 因为交易本身需要手续费，我们需要留出约 0.00001 SOL
        const solBalance = await connection.getBalance(subWallet.publicKey);
        const feeReserve = 5000; // 预留 5000 lamports 作为这笔交易的手续费
        if (solBalance <= feeReserve) return;
        const solSwept = solBalance - feeReserve;
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: subWallet.publicKey,
                toPubkey: mainWalletPublicKey,
                lamports: solSwept, 
            })
        );
        await sendAndConfirmTransaction(connection, tx, [subWallet]);
        console.log(`✅ 子钱包 #${id} 归集 ${(solSwept / 1e9).toFixed(4)} SOL 成功`);
        saveCheckpoint(id + 1);
    } catch (err) {
        console.error(`❌ 子钱包 #${id} 归集失败:`, err.message);
        recordFailedIndex(id);
    }
}

async function sweepAll(subWallets, mainWallet, mintAddress, connection, sdk) {
    const initialBalance = await connection.getBalance(mainWallet.publicKey);
    console.log("开始全量资金归集...");    
    for (const wallet of subWallets) {
        await sweepWallet(connection, wallet.keypair, wallet.index, mainWallet.publicKey, mintAddress, sdk);
        await new Promise(r => setTimeout(r, 1000));
    }
    const finalBalance = await connection.getBalance(mainWallet.publicKey);
    // 计算差值
    const totalSwept = finalBalance - initialBalance;
    console.log("所有钱包归集任务处理完毕");
    console.log(`\n--- 归集统计 ---`);
    console.log(`📈 归集前: ${initialBalance / 1e9} SOL`);
    console.log(`📉 归集后: ${finalBalance / 1e9} SOL`);
    console.log(`✨ 净归集总量: ${totalSwept / 1e9} SOL`);
}

async function getTokenBalance(connection, walletPublicKey, mintAddress) {
    try {
        const ataAddress = getAssociatedTokenAddressSync(
            new PublicKey(mintAddress),
            walletPublicKey
        );
        // 使用 'processed' 或 'confirmed' 提交级别，确保获取最新卖出后的结果
        const balanceResponse = await connection.getTokenAccountBalance(
            ataAddress, 
            'processed' 
        );
        // balanceResponse.value.amount 是字符串格式的原始 BigInt
        return BigInt(balanceResponse.value.amount);
    } catch (err) {
        // 如果账户不存在（比如还没创建过 ATA），余额自然是 0
        return 0n;
    }
}

async function executeSell(wallet, id, mintAddress, sellAmount, connection, sdk) {
    try {
        const result = await sdk.trading.sell({
            mintAccount: mintAddress,
            sellTokenAmount: new anchor.BN(sellAmount.toString()),
            minSolOutput: new anchor.BN('0'),
            payer: wallet.publicKey
        });
        result.transaction.feePayer = wallet.publicKey;
        result.transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        result.transaction.sign(wallet);
        const signature = await connection.sendRawTransaction(result.transaction.serialize());
        await connection.confirmTransaction(signature);
        console.log(`子钱包 #${id} 卖出成功`);
        
    } catch(err) {
        console.error(`❌ 子钱包 #${id} 卖出失败: ${err.message}`);
    }   
}

async function run() {
    const connection = new Connection(config.rpc, "confirmed");
    const privateKeyString = process.env.MAIN_WALLET_PRIVATE_KEY_FOR_HOLDER;
    if (!privateKeyString) {
        console.error("未找到环境变量 MAIN_WALLET_PRIVATE_KEY，请检查 .env 文件");
        process.exit(1);
    }
    const mainWallet = Keypair.fromSecretKey(bs58.decode(privateKeyString));
    console.log(`✅ 成功加载主钱包: ${mainWallet.publicKey.toBase58()}`);
    
    const { currentIndex, currentSweptIndex } = getCheckpoint();
    const subWallets = await generateChildWallets(config.mnemonic, currentSweptIndex, currentIndex);
   
    const options = getDefaultOptions(config.network);
    const sdk = new PinPetSdk(connection, SPINPET_PROGRAM_ID, options);
    await sweepAll(subWallets, mainWallet, config.mintAddress, connection, sdk)
}

run();
