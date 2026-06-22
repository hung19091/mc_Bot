const { goals } = require('mineflayer-pathfinder');
const { MY_MASTER_ID } = require('./config');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isInventoryFull = (bot) => bot.inventory.emptySlotCount() <= 2;

const storage = require('./storage');
const supplies = require('./supplies');

// 狀態管理物件
const state = {
    isLoopRunning: false,
    hasNotifiedNoShovel: false,
    isEscaping: false,
    isEating: false,
    justTeleported: false, // 💡 新增：落地緩衝鎖，防止傳送卡頓被誤殺
    stuckCheckInterval: null
};

// 核心功能：根據方塊名稱，自動裝備正確工具
async function equipToolForBlock(bot, blockName) {
    if (state.isEating) return;

    let toolKeyword = '';
    if (blockName.includes('dirt') || blockName.includes('grass') || blockName.includes('sand')) {
        toolKeyword = 'shovel';
    } else if (
        blockName.includes('stone') || blockName.includes('cobblestone') || blockName.includes('andesite') ||
        blockName.includes('diorite') || blockName.includes('granite')
    ) {
        toolKeyword = 'pickaxe';
    }

    if (!toolKeyword) return;

    const heldItem = bot.heldItem;
    if (heldItem && heldItem.name.includes(toolKeyword)) return;

    const tool = bot.inventory.items().find(item => item.name.includes(toolKeyword));
    if (tool) {
        try {
            await bot.equip(tool, 'hand');
            console.log(`🔧 [工具] 偵測到挖掘方塊 ${blockName}，自動切換裝備：${tool.name}`);
        } catch (err) {
            console.log(`⚠️ [工具] 切換工具失敗: ${err.message}`);
        }
    }
}

// 核心功能：獨立的防卡監控計時器
function startStuckMonitor(bot) {
    if (state.stuckCheckInterval) {
        clearInterval(state.stuckCheckInterval);
        state.stuckCheckInterval = null;
    }

    if (!bot.entity || !bot.entity.position) return;

    let lastPos = bot.entity.position.clone();
    let stuckCount = 0;

    state.stuckCheckInterval = setInterval(() => {
        if (!state.isLoopRunning || state.isEscaping || state.isEating || !bot.entity || !bot.entity.position) {
            stuckCount = 0;
            if (bot.entity && bot.entity.position) lastPos = bot.entity.position.clone();
            return;
        }

        const currentPos = bot.entity.position;
        const distance = lastPos.distanceTo(currentPos);

        if (distance < 0.2) {
            stuckCount++;

            // 💡 只有在「不是剛傳送落地」的情況下，發呆滿 6 秒才執行介入
            if (stuckCount % 6 === 0 && stuckCount !== 0) {
                if (state.justTeleported) {
                    console.log('⏳ [防卡緩衝] 偵測到疑似原地發呆，但目前處於落地緩衝期，不予介入。');
                } else {
                    console.log('🚨 [防卡自救] 確定發呆滿 6 秒！強行介入斬斷目前尋路！ 時間：' + new Date().toLocaleTimeString());
                    bot.pathfinder.stop();
                }
            }

            if (stuckCount >= 20) {
                console.log('⚠️ [防卡警告] BOT 已經連續發呆超過 20 秒了！釋放計時器並重新出發...');
                clearInterval(state.stuckCheckInterval);
                state.stuckCheckInterval = null;
                stuckCount = 0;

                // 透過外層超時安全引導重飛
                setTimeout(() => {
                    if (state.isLoopRunning) startLoop(bot);
                }, 500);
            }
        } else {
            stuckCount = 0;
            lastPos = currentPos.clone();
        }
    }, 1000);
}

async function startLoop(bot) {
    // 💡 徹底解決 MaxListenersExceededWarning：每次啟動前先解綁，確保不重疊
    setupHealthAndFoodListener(bot);
    setupDiggingListener(bot);

    try {
        if (!state.isLoopRunning) return;

        // ① 首次啟動補給檢查
        const readyToGo = await supplies.checkAndSupply(bot);
        if (!readyToGo) {
            state.isLoopRunning = false;
            console.log('🛑 [工作中止] 物資未齊全，拒絕執行傳送。');
            bot.chat(`/m ${MY_MASTER_ID} ❌ 補給點物資不足！請確認裝備區有足夠的鏟子與牛排後重新 go`);
            return;
        }

        // 檢查初始鏟子
        const hasShovel = bot.inventory.items().some(item => item.name.includes('shovel'));
        if (!hasShovel) {
            state.isEating = true; // 鎖定
            bot.chat('/warp HIRO_QQX_2');
            await sleep(7000);
            const initialCheck = await supplies.checkAndSupply(bot);
            state.isEating = false; // 解鎖
            if (!initialCheck) { state.isLoopRunning = false; return; }
        }

        // 執行隨機傳送
        console.log('➡️ [工作] 執行隨機傳送 /rtp...');
        state.justTeleported = true; // 🔒 啟動落地緩衝鎖
        bot.chat('/rtp');
        await sleep(7000);

        console.log('⚡ [系統] 已到達荒野，正式啟動防卡發呆監控。');
        startStuckMonitor(bot);

        // 落地 3 秒後解除緩衝鎖，給予充足的尋路加載時間
        setTimeout(() => {
            state.justTeleported = false;
            console.log('🔓 [系統] 落地緩衝期結束，防卡自救完全生效。');
        }, 5000);

        const mcData = require('minecraft-data')(bot.version);

        while (state.isLoopRunning) {
            let shovelExploded = false;

            // 3. 採集主迴圈
            while (!isInventoryFull(bot)) {
                if (state.isEscaping || state.isEating) { await sleep(1000); continue; }
                if (!state.isLoopRunning) return;

                const allDirtPositions = bot.findBlocks({
                    matching: mcData.blocksByName.dirt.id,
                    maxDistance: 10,
                    count: 30
                });

                const currentBotY = bot.entity.position.y;
                const filteredPositions = allDirtPositions.filter(pos => {
                    const yDiff = pos.y - currentBotY;
                    return yDiff <= 1.5 && yDiff >= -2.5;
                }).slice(0, 8);

                if (filteredPositions.length > 0) {
                    const targets = filteredPositions.map(pos => bot.blockAt(pos)).filter(Boolean);
                    try {
                        await bot.collectBlock.collect(targets, {
                            ignoreFrame: true,
                            count: targets.length,
                            chestRadius: 3,
                            itemRadius: 3,
                        });
                    } catch (err) {
                        // 檢查工具是否損壞
                        const hasShovelNow = bot.inventory.items().some(item => item.name.includes('shovel'));
                        if (!hasShovelNow) {
                            console.log('💥 [工作] 挖掘中斷且無鏟子！判定工具損壞，觸發自動補給...');
                            shovelExploded = true;
                            break;
                        }
                        console.log('🔄 [工作] 挖掘被中斷（方塊更新或被強制換目標），重新搜尋新目標...' + err.message);
                        await sleep(600);
                    }
                } else {
                    await sleep(600);
                }
            }

            if (state.isEscaping || state.isEating) { await sleep(1000); continue; }
            if (!state.isLoopRunning) return;

            // 關閉防卡，回家
            if (state.stuckCheckInterval) clearInterval(state.stuckCheckInterval);
            state.isEating = true; // 啟用基地商務鎖，防止尋路被中斷

            console.log('🚶 [工作] 開始返回基地進行後續處理...');
            bot.chat('/warp HIRO_QQX_2');
            await sleep(7000);

            if (!shovelExploded) {
                try {
                    console.log('🎒 [工作] 偵測到滿包，正在走向「倉儲區」箱子...');
                    await storage.storeAllItemsToSignChest(bot, '倉儲區');
                } catch (storeErr) {
                    console.log('❌ [儲存錯誤] 自動存箱時發生異常：', storeErr.message);
                }
            }

            try {
                console.log('🔄 [補給] 正在檢查與補給裝備物資...');
                const finalCheck = await supplies.checkAndSupply(bot);
                if (!finalCheck) {
                    state.isLoopRunning = false;
                    state.isEating = false;
                    return;
                }
            } catch (supErr) {
                console.log('❌ [補給錯誤] 補給異常：', supErr.message);
            }

            state.isEating = false; // 解除基地商務鎖

            console.log('🚀 [工作] 基地處理完成！重新出發前往荒野挖礦...');
            state.justTeleported = true; // 🔒 再次啟動落地緩衝鎖
            bot.chat('/rtp');
            await sleep(7000);

            startStuckMonitor(bot);
            setTimeout(() => { state.justTeleported = false; }, 5000);
        }
    } catch (globalErr) {
        console.log('⚠️ [循環異常] 發生非預期錯誤...', globalErr);
        state.isLoopRunning = false;
        if (state.stuckCheckInterval) clearInterval(state.stuckCheckInterval);
    }
}

function setupDiggingListener(bot) {
    // 先移除舊的，防止 Memory Leak
    bot.removeAllListeners('diggingStart');
    bot.on('diggingStart', async (block) => {
        if (!state.isLoopRunning || state.isEscaping || state.isEating) return;
        if (block && block.name) {
            await equipToolForBlock(bot, block.name);
        }
    });
}

function setupHealthAndFoodListener(bot) {
    // 先移除舊的，防止 Memory Leak
    bot.removeAllListeners('health');
    let lastHealth = bot.health || 20;

    bot.on('health', async () => {
        if (!state.isLoopRunning) return;

        if (bot.food <= 15 && !state.isEating && !state.isEscaping) {
            const steak = bot.inventory.items().find(item => item.name === 'cooked_beef');
            if (steak) {
                console.log(`🍖 [補給] 飢餓度過低 (${bot.food}/20)，開始吃牛排...`);
                state.isEating = true;
                try {
                    bot.pathfinder.stop();
                    await bot.equip(steak, 'hand');
                    await bot.consume();
                    console.log(`✅ [補給] 牛排吃飽了！目前飢餓度: ${bot.food}/20`);
                } catch (err) {
                    console.log(`⚠️ [補給] 吃牛排失敗: ${err.message}`);
                } finally {
                    state.isEating = false;
                }
            }
        }

        const currentHealth = bot.health;
        if (currentHealth < lastHealth) {
            if (state.isEscaping || state.isEating) {
                lastHealth = currentHealth;
                return;
            }
            console.log(`🚨 [安全防護] BOT 受傷了！立刻執行緊急 /rtp 逃跑！`);
            state.isEscaping = true;
            try {
                bot.pathfinder.stop();
                bot.chat('/rtp');
                await sleep(7000);
            } catch (err) {
                console.log('⚠️ [安全防護] 逃跑異常:', err);
            } finally {
                state.isEscaping = false;
            }
        }
        lastHealth = currentHealth;
    });
}

module.exports = { state, startLoop };