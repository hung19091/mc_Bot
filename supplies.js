const { goals } = require('mineflayer-pathfinder');
const { MY_MASTER_ID } = require('./config');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
        const hasSteak = hasItem(bot, 'cooked_beef', 20);

        if (hasShovel && hasPickaxe && hasSteak) {
            console.log('✅ [補給檢查] 物品齊全，準備出發！');
            return true;
        }

        console.log('⚠️ [補給檢查] 物資有缺少，準備前往裝備區補給...');

        // 2. 執行傳送到裝備區
        bot.chat('/warp HIRO_QQX_2');
        await sleep(7000); // 等待傳送與地圖載入

        // 3. 尋找告示牌
        const mcData = require('minecraft-data')(bot.version);
        const signBlockIds = mcData.blocksArray
            .filter(b => b.name.includes('sign'))
            .map(b => b.id);

        const signBlocks = bot.findBlocks({
            matching: signBlockIds,
            maxDistance: 16,
            count: 20
        });

        let targetChestBlock = null;

        for (const pos of signBlocks) {
            const block = bot.blockAt(pos);
            let signText = '';
            if (block.signText) {
                signText = block.signText;
            } else if (block.blockEntity && block.blockEntity.frontText) {
                signText = block.blockEntity.frontText.messages.join(' ');
            }

            // 🔍 檢查告示牌是否包含指定文字
            if (signText.includes('HIRO_NAGA') && signText.includes('裝備區')) {
                console.log(`🎯 [補給] 找到「HIRO_NAGA 裝備區」告示牌，座標: ${pos}`);

                // 尋找鄰近 1 格內的箱子
                const directions = [
                    pos.offset(1, 0, 0), pos.offset(-1, 0, 0),
                    pos.offset(0, 1, 0), pos.offset(0, -1, 0),
                    pos.offset(0, 0, 1), pos.offset(0, 0, -1)
                ];

                for (const adjPos of directions) {
                    const adjBlock = bot.blockAt(adjPos);
                    if (adjBlock && (adjBlock.name === 'chest' || adjBlock.name === 'trapped_chest')) {
                        targetChestBlock = adjBlock;
                        break;
                    }
                }
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
        await bot.pathfinder.goto(new goals.GoalGetToBlock(targetChestBlock.position.x, targetChestBlock.position.y, targetChestBlock.position.z));

        const chest = await bot.openChest(targetChestBlock);
        await sleep(500);

        // 5. 根據缺少的東西，精準拿取
        // 檢查箱子裡的物品清單
        const chestItems = chest.containerItems();

        // 🔨 補鏟子
        if (!hasItem(bot, 'shovel', 1)) {
            const chestShovel = chestItems.find(item => item.name.includes('shovel'));
            if (chestShovel) {
                console.log(`📥 [補給] 從箱子拿取鏟子: ${chestShovel.name}`);
                await chest.withdraw(chestShovel.type, null, 1);
                await sleep(300);
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
                await sleep(300);
            } else {
                console.log('⚠️ [補給警告] 箱子裡沒有十字鎬了！');
            }
        }

        // 🍖 補牛排至 64 個
        const currentSteakCount = getItemCount(bot, 'cooked_beef');
        if (currentSteakCount < 64) {
            const neededSteak = 64 - currentSteakCount;
            const chestSteak = chestItems.find(item => item.name === 'cooked_beef');

            if (chestSteak) {
                // 如果箱子裡的牛排不夠我要的量，有多少拿多少
                const amountToTake = Math.min(neededSteak, chestSteak.count);
                console.log(`📥 [補給] 從箱子拿取牛排 x${amountToTake}`);
                await chest.withdraw(chestSteak.type, null, amountToTake);
                await sleep(300);
            } else {
                console.log('⚠️ [補給警告] 箱子裡沒有牛排了！');
            }
        }

        // 關閉箱子
        chest.close();
        await sleep(500);

        // 6. 最終驗證：拿完之後再次檢查，避免箱子沒資源導致死循環
        const finalShovel = hasItem(bot, 'shovel', 1);
        const finalPickaxe = hasItem(bot, 'pickaxe', 1);
        const finalSteak = hasItem(bot, 'cooked_beef', 20); // 拿完後至少要有20個才給出發

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