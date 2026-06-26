const { goals } = require('mineflayer-pathfinder');
const { MY_MASTER_ID } = require('./config');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const STORAGE_CONFIG = {
    signSearchDistance: 16,
    signSearchCount: 20,
    chestPathSleepMs: 200
};

const CHEST_BLOCK_NAMES = new Set(['chest', 'trapped_chest']);

// 兼容不同版本告示牌資料格式。
function getSignText(block) {
    if (block.signText) return block.signText;
    if (block.blockEntity && block.blockEntity.frontText) {
        return block.blockEntity.frontText.messages.join(' ');
    }
    return '';
}

function getAdjacentPositions(pos) {
    return [
        pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
        pos.offset(0, 1, 0), pos.offset(0, -1, 0),
        pos.offset(0, 0, 1), pos.offset(0, 0, -1)
    ];
}

// 由告示牌座標找六個相鄰方塊中的箱子。
function findAdjacentChest(bot, pos) {
    const directions = getAdjacentPositions(pos);
    for (const adjPos of directions) {
        const adjBlock = bot.blockAt(adjPos);
        if (adjBlock && CHEST_BLOCK_NAMES.has(adjBlock.name)) {
            return adjBlock;
        }
    }
    return null;
}

async function storeAllItemsToSignChest(bot, keyword = '倉儲區') {
    try {
        const mcData = require('minecraft-data')(bot.version);

        // 1. 找出附近 16 格內所有的告示牌方塊型號
        const signBlockIds = mcData.blocksArray
            .filter(b => b.name.includes('sign'))
            .map(b => b.id);

        console.log('🔍 [儲存] 正在掃描周圍的告示牌...');
        const signBlocks = bot.findBlocks({
            matching: signBlockIds,
            maxDistance: STORAGE_CONFIG.signSearchDistance,
            count: STORAGE_CONFIG.signSearchCount
        });

        if (signBlocks.length === 0) {
            bot.chat(`/m ${MY_MASTER_ID} ❌ 周圍 16 格內找不到任何告示牌！`);
            return;
        }

        let targetChestBlock = null;

        // 2. 遍歷找到的告示牌，檢查上面的文字
        for (const pos of signBlocks) {
            const block = bot.blockAt(pos);
            const signText = getSignText(block);

            if (signText.includes('HIRO_NAGA') && signText.includes(keyword)) {
                console.log(`🎯 [儲存] 找到匹配的告示牌，座標: ${pos}`);

                // 3. 尋找這個告示牌鄰近（上下左右前後 1 格內）的箱子
                targetChestBlock = findAdjacentChest(bot, pos);
                if (targetChestBlock) break;
            }
        }

        if (!targetChestBlock) {
            bot.chat(`/m ${MY_MASTER_ID} ❌ 找到了告示牌，但在它旁邊找不到箱子！`);
            return;
        }

        // 4. 走向該箱子並打開它
        console.log(`🚶 [儲存] 正在走向指定的箱子...`);
        await bot.pathfinder.goto(new goals.GoalGetToBlock(targetChestBlock.position.x, targetChestBlock.position.y, targetChestBlock.position.z));

        const chest = await bot.openChest(targetChestBlock);
        console.log(`📦 [儲存] 箱子已打開，開始存放身上所有物品...`);

        const itemsToDeposit = bot.inventory.items();
        if (itemsToDeposit.length === 0) {
            bot.chat(`/m ${MY_MASTER_ID} 🤔 我身上本來就沒有任何物品。`);
            chest.close();
            return;
        }

        // 5. 存入物品
        for (const item of itemsToDeposit) {
            const name = item.name;

            // 檢查是否為重要物資：鏟子、十字鎬、牛排
            if (name.includes('shovel') || name.includes('pickaxe') || name === 'cooked_beef') {
                console.log(`🛡️ [儲存安全庫存] 保留不存入: ${name} x${item.count}`);
                continue; // 跳過這個物品，不放進箱子
            }

            try {
                await chest.deposit(item.type, null, item.count);
                console.log(`✅ [儲存] 成功存入: ${item.name} x${item.count}`);
                await sleep(STORAGE_CONFIG.chestPathSleepMs);
            } catch (depositErr) {
                console.log(`⚠️ [儲存] 無法存入物品 ${item.name}：`, depositErr);
            }
        }

        chest.close();
        bot.chat(`/m ${MY_MASTER_ID} 🎉 身上物品已全數嘗試存入告示牌箱子！`);

    } catch (err) {
        console.error('❌ [儲存錯誤]', err);
        bot.chat(`/m ${MY_MASTER_ID} ❌ 執行儲存時發生錯誤。`);
    }
}

module.exports = { storeAllItemsToSignChest };