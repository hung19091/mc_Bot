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
    justTeleported: false,
    currentLoopId: 0, // 💡 新增：回合標記，用來徹底秒殺舊的背景分身迴圈
    stuckCheckInterval: null
};

// 徹底清空 Bot 的尋路與採集記憶
function clearBotMemory(bot) {
    try {
        bot.pathfinder.stop();
        bot.pathfinder.setGoal(null);
        if (bot.collectBlock && typeof bot.collectBlock.cancel === 'function') {
            bot.collectBlock.cancel();
        }
        // 清理幽靈監聽器
        const eventNames = bot.eventNames();
        for (const name of eventNames) {
            if (typeof name === 'string' && name.startsWith('blockUpdate:')) {
                bot.removeAllListeners(name);
            }
        }
    } catch (err) {
        // 靜音處理
    }
}

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
        } catch (err) { }
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

    state.stuckCheckInterval = setInterval(async () => {
        if (!state.isLoopRunning || state.isEscaping || state.isEating || !bot.entity || !bot.entity.position) {
            stuckCount = 0;
            if (bot.entity && bot.entity.position) lastPos = bot.entity.position.clone();
            return;
        }

        const currentPos = bot.entity.position;
        const distance = lastPos.distanceTo(currentPos);

        if (distance < 0.2) {
            stuckCount++;

            if (stuckCount % 6 === 0 && stuckCount !== 0) {
                if (state.justTeleported) {
                    console.log('⏳ [防卡緩衝] 偵測到原地發呆，但目前處於落地緩衝期，不予介入。');
                } else {
                    console.log('🚨 [防卡自救] 確定發呆滿 6 秒！強行介入斬斷目前尋路！');
                    bot.pathfinder.stop();
                }
            }

            // 💡 核心修正：發呆滿 20 秒，外部強制斬斷並引導重飛
            if (stuckCount >= 20) {
                console.log('⚠️ [防卡警告] BOT 已經連續發呆超過 20 秒（非同步死鎖）！外部強制介入重飛...');
                clearInterval(state.stuckCheckInterval);
                state.stuckCheckInterval = null;
                stuckCount = 0;

                // 外部強制重置與救回
                clearBotMemory(bot);
                state.isEating = true; // 鎖定
                bot.chat('/warp HIRO_QQX_2');
                await sleep(7000);
                state.isEating = false; // 解鎖

                // 再次呼叫 startLoop 會讓 LoopId + 1，舊的 while 迴圈醒來後會自動暴斃
                if (state.isLoopRunning) startLoop(bot);
            }
        } else {
            stuckCount = 0;
            lastPos = currentPos.clone();
        }
    }, 1000);
}

async function startLoop(bot) {
    // 💡 回合數遞增，確保這是唯一合法的執行緒
    const myLoopId = ++state.currentLoopId;

    bot.setMaxListeners(50);
    bot.pathfinder.thinkSteps = 40000;
    bot.pathfinder.timeout = 2000;

    setupHealthAndFoodListener(bot);
    setupDiggingListener(bot);

    try {
        if (!state.isLoopRunning) return;

        // ① 首次啟動補給檢查
        const readyToGo = await supplies.checkAndSupply(bot);
        if (!readyToGo) {
            state.isLoopRunning = false;
            console.log('🛑 [工作中止] 物資未齊全，拒絕執行傳送。');
            return;
        }

        // 執行隨機傳送
        console.log(`➡️ [工作] [回合:${myLoopId}] 執行隨機傳送 /rtp...`);
        clearBotMemory(bot);
        state.justTeleported = true;
        bot.chat('/rtp');
        await sleep(7000);

        console.log('⚡ [系統] 已到達荒野，正式啟動防卡發呆監控。');
        startStuckMonitor(bot);

        setTimeout(() => {
            state.justTeleported = false;
            console.log('🔓 [系統] 落地緩衝期結束，防卡自救完全生效。');
        }, 5000);

        const mcData = require('minecraft-data')(bot.version);

        while (state.isLoopRunning) {
            // 💡 檢查點：如果當前全域回合數不等於我這一個 while 的回合數，代表我已經是被淘汰的「分身」，直接自盡！
            if (state.currentLoopId !== myLoopId) {
                console.log(`💀 [執行緒清理] 成功秒殺舊的回合分身迴圈 (ID: ${myLoopId})。`);
                return;
            }

            let shovelExploded = false;
            let continuousErrors = 0;

            // 3. 採集主迴圈
            while (!isInventoryFull(bot)) {
                if (state.currentLoopId !== myLoopId) return; // 雙重保險
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
                    if (targets.length === 0) { await sleep(100); continue; }

                    try {
                        await bot.collectBlock.collect(targets, {
                            ignoreFrame: true,
                            count: targets.length,
                            chestRadius: 3,
                            itemRadius: 3,
                        });
                        continuousErrors = 0;
                    } catch (err) {
                        // 如果在被外部重飛後才從死鎖醒來，發現回合不對，立刻結束，不執行後續邏輯
                        if (state.currentLoopId !== myLoopId) return;

                        const hasShovelNow = bot.inventory.items().some(item => item.name.includes('shovel'));
                        if (!hasShovelNow) {
                            console.log('💥 [工作] 挖掘中斷且無鏟子！判定工具損壞，觸發自動補給...');
                            shovelExploded = true;
                            break;
                        }

                        continuousErrors++;
                        await sleep(100);

                        if (continuousErrors >= 12) {
                            console.log('⚠️ [防卡主動介入] 多目標採集連續出現實質阻礙，決定放棄此區換新地點！');
                            break;
                        }
                    }
                } else {
                    await sleep(600);
                }
            }

            if (state.currentLoopId !== myLoopId) return;
            if (state.isEscaping || state.isEating) { await sleep(1000); continue; }
            if (!state.isLoopRunning) return;

            // 正常回城
            if (state.stuckCheckInterval) clearInterval(state.stuckCheckInterval);
            state.isEating = true;

            console.log('🚶 [工作] 開始返回基地進行後續處理...');
            bot.chat('/warp HIRO_QQX_2');
            await sleep(7000);

            if (!shovelExploded) {
                try {
                    console.log('🎒 [工作] 正在走向「倉儲區」箱子...');
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

            state.isEating = false;

            console.log('🚀 [工作] 重新出發前往荒野挖礦 /rtp...');
            clearBotMemory(bot);
            state.justTeleported = true;
            bot.chat('/rtp');
            await sleep(7000);

            startStuckMonitor(bot);
            setTimeout(() => { state.justTeleported = false; }, 5000);
        }
    } catch (globalErr) {
        state.isLoopRunning = false;
        if (state.stuckCheckInterval) clearInterval(state.stuckCheckInterval);
    }
}

function setupDiggingListener(bot) {
    bot.removeAllListeners('diggingStart');
    bot.on('diggingStart', async (block) => {
        if (!state.isLoopRunning || state.isEscaping || state.isEating) return;
        if (block && block.name) {
            await equipToolForBlock(bot, block.name);
        }
    });
}

function setupHealthAndFoodListener(bot) {
    bot.removeAllListeners('health');
    let lastHealth = bot.health || 20;

    bot.on('health', async () => {
        if (!state.isLoopRunning) return;

        if (bot.food <= 15 && !state.isEating && !state.isEscaping) {
            const steak = bot.inventory.items().find(item => item.name === 'cooked_beef');
            if (steak) {
                state.isEating = true;
                try {
                    bot.pathfinder.stop();
                    await bot.equip(steak, 'hand');
                    await bot.consume();
                } catch (err) {
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
            } finally {
                state.isEscaping = false;
            }
        }
        lastHealth = currentHealth;
    });
}

module.exports = { state, startLoop };