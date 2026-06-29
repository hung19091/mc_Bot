const { goals } = require('mineflayer-pathfinder');
const { MY_MASTER_ID } = require('./config');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const SUPPLY_CONFIG = {
    steakMinToStart: 20,
    steakTargetCount: 64,
    warpWaitMs: 7000,
    signSearchDistance: 16,
    signSearchCount: 20,
    afterOpenChestWaitMs: 500,
    actionPauseMs: 300,
    afterCloseChestWaitMs: 500
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

// 從告示牌周圍找可互動箱子。
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
 * 檢查身上是否有特定物品
 * @param {Object} bot Mineflayer 實例
 * @param {string} keyword 物品名稱關鍵字
 * @param {number} minCount 最少需要多少個
 */
function hasItem(bot, keyword, minCount = 1) {
    const items = bot.inventory.items().filter(item => item.name.includes(keyword));
    const totalCount = items.reduce((sum, item) => sum + item.count, 0);
    return totalCount >= minCount;
}

/**
 * 取得身上特定物品的總數量
 */
function getItemCount(bot, keyword) {
    const items = bot.inventory.items().filter(item => item.name.includes(keyword));
    return items.reduce((sum, item) => sum + item.count, 0);
}

/**
 * 核心功能：檢查三件套，並在有缺時自動前往補給
 * @returns {Promise<boolean>} 是否成功備齊物資
 */
async function checkAndSupply(bot) {
    try {
        // 1. 檢查自己身上是否有三件套
        const hasShovel = hasItem(bot, 'shovel', 1);
        const hasPickaxe = hasItem(bot, 'pickaxe', 1);
        const hasSteak = hasItem(bot, 'cooked_beef', SUPPLY_CONFIG.steakMinToStart);

        if (hasShovel && hasPickaxe && hasSteak) {
            console.log('✅ [補給檢查] 物品齊全，準備出發！');
            return true;
        }

        console.log('⚠️ [補給檢查] 物資有缺少，準備前往裝備區補給...');

        // 2. 執行傳送到裝備區
        bot.chat('/warp HIRO_QQX_2');
        await sleep(SUPPLY_CONFIG.warpWaitMs); // 等待傳送與地圖載入

        // 3. 尋找告示牌
        const mcData = require('minecraft-data')(bot.version);
        const signBlockIds = mcData.blocksArray
            .filter(b => b.name.includes('sign'))
            .map(b => b.id);

        const signBlocks = bot.findBlocks({
            matching: signBlockIds,
            maxDistance: SUPPLY_CONFIG.signSearchDistance,
            count: SUPPLY_CONFIG.signSearchCount
        });

        let targetChestBlock = null;

        for (const pos of signBlocks) {
            const block = bot.blockAt(pos);
            const signText = getSignText(block);

            // 🔍 檢查告示牌是否包含指定文字
            if (signText.includes('HIRO_NAGA') && signText.includes('裝備區')) {
                console.log(`🎯 [補給] 找到「HIRO_NAGA 裝備區」告示牌，座標: ${pos}`);

                // 尋找鄰近 1 格內的箱子
                targetChestBlock = findAdjacentChest(bot, pos);
                if (targetChestBlock) break;
            }
        }

        if (!targetChestBlock) {
            console.log('❌ [補給錯誤] 找不到對應的補給箱子！');
            bot.chat(`/m ${MY_MASTER_ID} ❌ 找不到「HIRO_NAGA 裝備區」的箱子！`);
            return false;
        }

        // 4. 走向箱子並打開
        console.log('🚶 [補給] 正在走向補給箱子...');
        const navTargets = buildChestNavigationTargets(bot, targetChestBlock);
        let chest = null;

        for (const target of navTargets) {
            try {
                if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') {
                    bot.pathfinder.stop();
                }

                await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 1));
                chest = await bot.openChest(targetChestBlock);
                await sleep(SUPPLY_CONFIG.afterOpenChestWaitMs);
                break;
            } catch (navErr) {
                console.log(`⚠️ [補給] 導航到 ${target.x},${target.y},${target.z} 失敗：`, navErr && navErr.message ? navErr.message : navErr);
            }
        }

        if (!chest) {
            console.log('⚠️ [補給] 導航全部失敗，直接嘗試開箱...');
            try {
                chest = await bot.openChest(targetChestBlock);
                await sleep(SUPPLY_CONFIG.afterOpenChestWaitMs);
            } catch (openErr) {
                console.log('❌ [補給] 無法開啟箱子：', openErr && openErr.message ? openErr.message : openErr);
                bot.chat(`/m ${MY_MASTER_ID} ❌ 無法靠近或開啟補給箱。`);
                return false;
            }
        }

        // 5. 根據缺少的東西，精準拿取
        // 檢查箱子裡的物品清單
        const chestItems = chest.containerItems();

        // 🔨 補鏟子
        if (!hasItem(bot, 'shovel', 1)) {
            const chestShovel = chestItems.find(item => item.name.includes('shovel'));
            if (chestShovel) {
                console.log(`📥 [補給] 從箱子拿取鏟子: ${chestShovel.name}`);
                await chest.withdraw(chestShovel.type, null, 1);
                await sleep(SUPPLY_CONFIG.actionPauseMs);
            } else {
                console.log('⚠️ [補給警告] 箱子裡沒有鏟子了！');
            }
        }

        // ⛏️ 補十字鎬
        if (!hasItem(bot, 'pickaxe', 1)) {
            const chestPickaxe = chestItems.find(item => item.name.includes('pickaxe'));
            if (chestPickaxe) {
                console.log(`📥 [補給] 從箱子拿取十字鎬: ${chestPickaxe.name}`);
                await chest.withdraw(chestPickaxe.type, null, 1);
                await sleep(SUPPLY_CONFIG.actionPauseMs);
            } else {
                console.log('⚠️ [補給警告] 箱子裡沒有十字鎬了！');
            }
        }

        // 🍖 補牛排至 64 個
        const currentSteakCount = getItemCount(bot, 'cooked_beef');
        if (currentSteakCount < SUPPLY_CONFIG.steakTargetCount) {
            const neededSteak = SUPPLY_CONFIG.steakTargetCount - currentSteakCount;
            const chestSteak = chestItems.find(item => item.name === 'cooked_beef');

            if (chestSteak) {
                // 如果箱子裡的牛排不夠我要的量，有多少拿多少
                const amountToTake = Math.min(neededSteak, chestSteak.count);
                console.log(`📥 [補給] 從箱子拿取牛排 x${amountToTake}`);
                await chest.withdraw(chestSteak.type, null, amountToTake);
                await sleep(SUPPLY_CONFIG.actionPauseMs);
            } else {
                console.log('⚠️ [補給警告] 箱子裡沒有牛排了！');
            }
        }

        // 關閉箱子
        chest.close();
        await sleep(SUPPLY_CONFIG.afterCloseChestWaitMs);

        // 6. 最終驗證：拿完之後再次檢查，避免箱子沒資源導致死循環
        const finalShovel = hasItem(bot, 'shovel', 1);
        const finalPickaxe = hasItem(bot, 'pickaxe', 1);
        const finalSteak = hasItem(bot, 'cooked_beef', SUPPLY_CONFIG.steakMinToStart); // 拿完後至少要有20個才給出發

        if (finalShovel && finalPickaxe && finalSteak) {
            console.log('✅ [補給檢查] 補給完畢，準備出發！');
            return true;
        } else {
            console.log('❌ [補給失敗] 箱子物資不足，無法補齊三件套！安全停工。');
            bot.chat(`/m ${MY_MASTER_ID} ❌ 裝備箱物資不夠我補給，請主人幫忙手動補貨！`);
            return false; // 物資有缺，回傳 false 防止無限循環
        }

    } catch (err) {
        console.error('❌ [補給模組異常]', err);
        return false;
    }
}

module.exports = { checkAndSupply };