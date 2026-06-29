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

/**
 * 產生可接近箱子的候選站位，並依與 bot 距離排序。
 * @param {import('mineflayer').Bot} bot
 * @param {any} chestBlock
 * @returns {Array<{x:number,y:number,z:number}>}
 */
function buildChestNavigationTargets(bot, chestBlock) {
    const chestPos = chestBlock.position;
    const origin = bot.entity && bot.entity.position
        ? bot.entity.position
        : chestPos;

    const botLevelY = Math.floor(origin.y);
    const candidates = [
        { x: chestPos.x + 1, y: botLevelY, z: chestPos.z },
        { x: chestPos.x - 1, y: botLevelY, z: chestPos.z },
        { x: chestPos.x, y: botLevelY, z: chestPos.z + 1 },
        { x: chestPos.x, y: botLevelY, z: chestPos.z - 1 },
        { x: chestPos.x + 1, y: botLevelY, z: chestPos.z + 1 },
        { x: chestPos.x - 1, y: botLevelY, z: chestPos.z - 1 }
    ];

    candidates.sort((a, b) => {
        const distA = Math.abs(a.x - origin.x) + Math.abs(a.y - origin.y) + Math.abs(a.z - origin.z);
        const distB = Math.abs(b.x - origin.x) + Math.abs(b.y - origin.y) + Math.abs(b.z - origin.z);
        return distA - distB;
    });

    return candidates;
}

/**
 * 取最優先的箱子接近目標，供外部快速導航使用。
 * @param {import('mineflayer').Bot} bot
 * @param {any} chestBlock
 * @returns {any|null}
 */
function buildChestNavigationGoal(bot, chestBlock) {
    const [target] = buildChestNavigationTargets(bot, chestBlock);
    if (!target) {
        return null;
    }

    return new goals.GoalNear(target.x, target.y, target.z, 1);
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

/**
 * 依告示牌關鍵字尋找對應箱子，並將背包中非核心物資存入。
 * @param {import('mineflayer').Bot} bot
 * @param {string} [keyword='倉儲區']
 * @returns {Promise<void>}
 */
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

        // 4. 先嘗試走到箱子旁邊；若導航失敗就直接嘗試開箱
        console.log(`🚶 [儲存] 正在走向指定的箱子...`);
        const navTargets = buildChestNavigationTargets(bot, targetChestBlock);
        let chest = null;

        for (const target of navTargets) {
            try {
                bot.pathfinder.stop();
                await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1));
                chest = await bot.openChest(targetChestBlock);
                break;
            } catch (navErr) {
                console.log(`⚠️ [儲存] 導航到 ${target.x},${target.y},${target.z} 失敗：`, navErr && navErr.message ? navErr.message : navErr);
            }
        }

        if (!chest) {
            console.log(`⚠️ [儲存] 導航全部失敗，直接嘗試開箱...`);
            try {
                chest = await bot.openChest(targetChestBlock);
            } catch (openErr) {
                console.log(`❌ [儲存] 無法開啟箱子：`, openErr && openErr.message ? openErr.message : openErr);
                bot.chat(`/m ${MY_MASTER_ID} ❌ 無法靠近或開啟儲物箱。`);
                return;
            }
        }

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

module.exports = { storeAllItemsToSignChest, buildChestNavigationGoal, buildChestNavigationTargets };