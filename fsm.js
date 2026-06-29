const storage = require('./storage');
const supplies = require('./supplies');
const mining = require('./mining');
const { goals } = require('mineflayer-pathfinder');

// FSM 協調層參數：只放與狀態決策相關的常數。
const LOOP_CONFIG = {
    tickMs: 500,
    teleportWaitMs: 7000,
    hungryThreshold: 15,
    steakMinToStart: 20,
    defaultHealth: 20,
    damageSourceCheckRadius: 4,
    miningIdleWarningMs: 5000,
    miningIdleRtpMs: 20000,
    miningStuckCheckRadius: 1.5
};

const WARP_BASE_COMMAND = '/warp HIRO_QQX_2';
const RTP_COMMAND = '/rtp';

const HOSTILE_MOBS = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned', 'husk', 'stray'
]);

const FSM_STATE = Object.freeze({
    Idle: 'Idle',
    Escape: 'Escape',
    Eat: 'Eat',
    ManualStorage: 'ManualStorage',
    Supply: 'Supply',
    InventoryStorage: 'InventoryStorage',
    EnsureWild: 'EnsureWild',
    Mine: 'Mine'
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 全域狀態：由 FSM 統一持有，避免分散在各模組。
const state = {
    isLoopRunning: false,
    tickTimer: null,
    isTicking: false,
    mcData: null,
    pendingStorage: false,
    isInWild: false,
    collectErrorCount: 0,
    damageDetected: false,
    enemyDetected: false,
    healthListenerInstalled: false,
    lastHealth: LOOP_CONFIG.defaultHealth,
    currentState: FSM_STATE.Idle,
    miningLastPosition: null,
    miningIdleSince: null,
    miningIdleWarningShown: false
};

// Rule Engine：優先權表驅動決策。排序一次在 startLoop，避免每 tick 重排。
let sortedRules = [];

const rules = [
    {
        name: FSM_STATE.Escape,
        priority: 100,
        condition: () => hasThreat(),
        action: runEscape
    },
    {
        name: FSM_STATE.Escape,
        priority: 95,
        condition: (bot) => shouldRtpForMiningStuck(bot),
        action: runEscape
    },
    {
        name: FSM_STATE.Eat,
        priority: 90,
        condition: (bot) => shouldEat(bot),
        action: runEat
    },
    {
        name: FSM_STATE.ManualStorage,
        priority: 80,
        condition: () => state.pendingStorage,
        action: runManualStorage
    },
    {
        name: FSM_STATE.Supply,
        priority: 70,
        condition: (bot) => needSupplies(bot),
        action: runSupply
    },
    {
        name: FSM_STATE.InventoryStorage,
        priority: 60,
        condition: (bot) => isInventoryFull(bot),
        action: runInventoryStorage
    },
    {
        name: FSM_STATE.EnsureWild,
        priority: 50,
        condition: () => !state.isInWild,
        action: runEnsureWild
    },
    {
        name: FSM_STATE.Mine,
        priority: 10,
        condition: () => true,  // 總是可以執行（fallback）
        action: runMine
    }
];

function isInventoryFull(bot) {
    return bot.inventory.emptySlotCount() <= 2;
}

function wasDamagedByHostileMob(bot) {
    if (!bot.entity || !bot.entity.position) {
        return false;
    }

    // 只在受傷當下做一次近距離判斷，避免每 tick 都掃描全實體。
    const attacker = bot.nearestEntity((entity) => {
        if (!entity || entity.type !== 'mob' || !entity.name || !entity.position) {
            return false;
        }

        if (!HOSTILE_MOBS.has(entity.name)) {
            return false;
        }

        return bot.entity.position.distanceTo(entity.position) <= LOOP_CONFIG.damageSourceCheckRadius;
    });

    return Boolean(attacker);
}

function installHealthDamageSensor(bot) {
    if (state.healthListenerInstalled) {
        return;
    }

    state.lastHealth = bot.health || LOOP_CONFIG.defaultHealth;
    state.healthListenerInstalled = true;

    bot.on('health', () => {
        // 主循環未啟動時只更新基準血量，不觸發逃跑判斷。
        if (!state.isLoopRunning) {
            state.lastHealth = bot.health || LOOP_CONFIG.defaultHealth;
            return;
        }

        const currentHealth = bot.health || LOOP_CONFIG.defaultHealth;
        if (currentHealth < state.lastHealth) {
            /*
            const hitByHostileMob = wasDamagedByHostileMob(bot);
            
            if (hitByHostileMob) {
                state.damageDetected = true;
                console.log(`⚠️ [FSM] 受傷且來源為 hostile mob！血量: ${state.lastHealth} -> ${currentHealth}`);
            } else {
                console.log(`ℹ️ [FSM] 受傷但非 hostile mob 來源，忽略 RTP。血量: ${state.lastHealth} -> ${currentHealth}`);
            }
            */

            state.damageDetected = true;
        }

        state.lastHealth = currentHealth;
    });
}

function hasThreat() {
    return state.damageDetected;
}

/**
 * 強制清理 pathfinder 內部狀態，降低上次導航殘留對後續流程的干擾。
 * @param {import('mineflayer').Bot} bot
 */
function resetPathfinderState(bot) {
    if (!bot || !bot.pathfinder) {
        return;
    }

    try {
        bot.pathfinder.stop();
    } catch (e) { }

    try {
        bot.pathfinder.setGoal(null);
    } catch (e) { }

    try {
        if (bot.pathfinder.currentGoal) {
            bot.pathfinder.currentGoal = null;
        }
    } catch (e) { }

    try {
        if (bot.pathfinder.goal) {
            bot.pathfinder.goal = null;
        }
    } catch (e) { }

    try {
        if (bot.pathfinder.path) {
            bot.pathfinder.path = null;
        }
    } catch (e) { }
}

async function enterMiningAfterEscape(bot) {
    state.currentState = FSM_STATE.Mine;
    await mining.runMineStep(bot, {
        mcData: state.mcData,
        loopConfig: mining.MINING_CONFIG,
        state: {
            ...state,
            markMiningProgress: () => markMiningProgress(bot)
        }
    });
}

/**
 * 重置採礦卡點檢測狀態（基準位置、計時器、警告旗標）。
 */
function resetMiningIdleState() {
    state.miningLastPosition = null;
    state.miningIdleSince = null;
    state.miningIdleWarningShown = false;
}

/**
 * 在採礦有實際進展時更新基準點，避免誤判為卡住。
 * @param {import('mineflayer').Bot} bot
 */
function markMiningProgress(bot) {
    if (!state.isLoopRunning || !state.isInWild || state.currentState !== FSM_STATE.Mine || !bot || !bot.entity || !bot.entity.position) {
        return;
    }

    state.miningLastPosition = {
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z
    };
    state.miningIdleSince = Date.now();
    state.miningIdleWarningShown = false;
}

/**
 * 檢查 bot 是否在採礦狀態長時間停滯，超過門檻時回傳 true 供 FSM 觸發 /rtp。
 * @param {import('mineflayer').Bot} bot
 * @returns {boolean}
 */
function shouldRtpForMiningStuck(bot) {
    if (!state.isLoopRunning || !state.isInWild || state.currentState !== FSM_STATE.Mine || !bot.entity || !bot.entity.position) {
        return false;
    }

    const currentPos = bot.entity.position;


    // 1. 初始化基準點
    if (!state.miningLastPosition) {
        state.miningLastPosition = { x: currentPos.x, y: currentPos.y, z: currentPos.z };
        state.miningIdleSince = Date.now();
        state.miningIdleWarningShown = false;
        return false;
    }

    // 2. 計算目前位置與「上次紀錄的發呆基準點」的歐幾里得距離
    const dx = currentPos.x - state.miningLastPosition.x;
    const dy = currentPos.y - state.miningLastPosition.y;
    const dz = currentPos.z - state.miningLastPosition.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // 3. 判定是否還卡在原地 (移動範圍小於 2.0 格都算卡住)
    const isStuck = distance < 2.0;

    if (!isStuck) {
        // 只有當 bot 真的大範圍移動了（代表有認真在挖並前進），才更新基準點與重置計時器
        state.miningLastPosition = { x: currentPos.x, y: currentPos.y, z: currentPos.z };
        state.miningIdleSince = Date.now();
        state.miningIdleWarningShown = false;
        return false;
    }

    // 4. 計算卡住的時間
    const idleMs = Date.now() - state.miningIdleSince;
    if (idleMs >= LOOP_CONFIG.miningIdleRtpMs) {
        console.log(`⚠️ [FSM] 採礦發呆超過 ${LOOP_CONFIG.miningIdleRtpMs / 1000} 秒，執行 /rtp。`);
        resetMiningIdleState();
        return true;
    }

    if (!state.miningIdleWarningShown && idleMs >= LOOP_CONFIG.miningIdleWarningMs) {
        state.miningIdleWarningShown = true;
        console.log(`⚠️ [FSM] 採礦發呆超過 ${LOOP_CONFIG.miningIdleWarningMs / 1000} 秒，請注意。`);
    }

    return false;
}

function shouldEat(bot) {
    return bot.food <= LOOP_CONFIG.hungryThreshold && mining.hasItem(bot, 'cooked_beef', 1);
}

function needSupplies(bot) {
    const hasShovel = mining.hasItem(bot, 'shovel', 1);
    const hasPickaxe = mining.hasItem(bot, 'pickaxe', 1);
    const hasSteak = mining.hasItem(bot, 'cooked_beef', LOOP_CONFIG.steakMinToStart);
    return !(hasShovel && hasPickaxe && hasSteak);
}

/**
 * 依優先度挑選第一個 condition 成立的規則。
 * @param {import('mineflayer').Bot} bot
 * @returns {{name:string, priority:number, condition:Function, action:Function}|null}
 */
function pickRuleByPriority(bot) {
    // 遍歷排序好的 rules，取第一個 condition 為 true 的規則。
    for (const rule of sortedRules) {
        try {
            if (rule.condition(bot)) {
                console.log(`  ✓ [Rule] ${rule.name} 符合條件 (優先度: ${rule.priority})`);
                return rule;
            }
        } catch (err) {
            console.log(`⚠️ [FSM] Rule "${rule.name}" condition error:`, err.message);
        }
    }
    return null;  // 不應該發生（Mine 總是 true）
}

/**
 * 緊急脫困流程：清理採礦與導航殘留狀態後執行 /rtp，並重新接回採礦。
 * @param {import('mineflayer').Bot} bot
 * @returns {Promise<void>}
 */
async function runEscape(bot) {
    console.log(`🏃 [Action] 偵測到危機或卡死，準備執行 /rtp...`);

    // 1. 強力清理底層所有可能殘留的異步任務與計時器
    try {
        // 中斷尋路
        resetPathfinderState(bot);

        // 中斷挖掘
        if (typeof bot.stopDigging === 'function') {
            bot.stopDigging();
        }

        // 清空當前目標方塊與挖掘狀態
        bot.targetBlock = null;
        bot.isDigging = false;

        // 核心修正：強制清理 collectBlock 的內部狀態
        if (bot.collectBlock) {
            // 很多版本的 collectBlock 在中斷時不會自動釋放「正在採集中」的鎖定（Lock）
            // 這裡直接將內部行為標記為結束，強制解鎖
            if (bot.collectBlock.customEvents) {
                bot.collectBlock.customEvents.removeAllListeners();
            }
            // 重置可能殘留的對象
            bot.collectBlock.targets = [];
            bot.collectBlock.currentTarget = null;
        }
    } catch (e) {
        console.log(`⚠️ [FSM] 清理底層動作時發生微小錯誤，忽略並繼續:`, e.message);
    }

    // 2. 執行隨機傳送
    bot.chat(RTP_COMMAND);
    console.log(`⏳ [Action] 已發送 /rtp，等待傳送緩衝 ${LOOP_CONFIG.teleportWaitMs / 1000} 秒...`);
    await sleep(LOOP_CONFIG.teleportWaitMs);

    // 3. 傳送完成後，務必重新整理周圍方塊快取與視線
    try {
        bot.clearControlStates(); // 重置所有按鍵狀態（前進、後退、挖等），防止傳送後 bot 還在按著某個鍵
        await bot.waitForChunksToLoad(); // ⏳ 關鍵：等待新地點的區塊載入完畢，否則 findBlocks 會找不到任何泥土
    } catch (e) {
        console.log(`⚠️ [FSM] 區塊載入等待超時，直接開始採礦`);
    }

    // 4. 重置 FSM 所有狀態旗標
    state.isInWild = true;
    state.damageDetected = false;
    state.enemyDetected = false;
    state.collectErrorCount = 0;

    resetMiningIdleState(); // 重新開始計算新地點的發呆時間
    state.currentState = FSM_STATE.Mine;
    await enterMiningAfterEscape(bot);

    console.log(`✅ [Action] 隨機傳送完畢且底層重置成功，開始在新地點採礦！`);
}

async function runEat(bot) {
    console.log(`🍖 [Action] 開始吃肉（飢餓度: ${bot.food})`);
    const steak = bot.inventory.items().find((item) => item.name === 'cooked_beef');
    if (!steak) {
        console.log(`⚠️ [Action] 找不到烤牛肉！`);
        return;
    }

    bot.pathfinder.stop();
    await bot.equip(steak, 'hand');
    await bot.consume();
    console.log(`✅ [Action] 吃完了（飢餓度: ${bot.food})`);
}

async function runManualStorage(bot) {
    // 手動存倉完成後會重置到非野外，讓流程重新走補給/出發判斷。
    console.log(`💾 [Action] 手動存倉中...`);
    bot.chat(WARP_BASE_COMMAND);
    await sleep(LOOP_CONFIG.teleportWaitMs);
    await storage.storeAllItemsToSignChest(bot, '倉儲區');

    const ok = await supplies.checkAndSupply(bot);
    if (!ok) {
        console.log(`❌ [Action] 補給失敗，停止循環`);
        state.pendingStorage = false;
        stopLoop();
        return;
    }

    state.pendingStorage = false;
    state.isInWild = false;
    console.log(`✅ [Action] 存倉完成`);
}

async function runSupply(bot) {
    console.log(`📦 [Action] 補給中...`);
    const ready = await supplies.checkAndSupply(bot);
    if (!ready) {
        console.log(`❌ [Action] 補給失敗，停止循環`);
        stopLoop();
        return;
    }

    state.isInWild = false;
    console.log(`✅ [Action] 補給完成`);
}

async function runInventoryStorage(bot) {
    console.log(`🏠 [Action] 背包滿，回倉存物中...`);
    bot.chat(WARP_BASE_COMMAND);
    await sleep(LOOP_CONFIG.teleportWaitMs);
    await storage.storeAllItemsToSignChest(bot, '倉儲區');

    const ready = await supplies.checkAndSupply(bot);
    if (!ready) {
        console.log(`❌ [Action] 倉儲補給失敗，停止循環`);
        stopLoop();
        return;
    }

    state.isInWild = false;
    state.collectErrorCount = 0;
    console.log(`✅ [Action] 倉儲完成，重新出發`);
}

async function runEnsureWild(bot) {
    console.log(`🌍 [Action] 前往野外中...`);
    bot.pathfinder.stop();
    bot.chat(RTP_COMMAND);
    await sleep(LOOP_CONFIG.teleportWaitMs);
    state.isInWild = true;
    state.collectErrorCount = 0;
    console.log(`✅ [Action] 已到達野外`);
}

async function runMine(bot) {
    // 採礦細節委派給 mining 模組，FSM 只負責調度。
    if (!bot.entity || !bot.entity.position) {
        console.log('⚠️ [FSM] 採礦前沒有有效的 bot 位置，跳過。');
        return;
    }

    const before = {
        position: { ...bot.entity.position },
        digging: Boolean(bot.isDigging),
        target: bot.targetBlock ? bot.targetBlock.position : null
    };

    console.log(`⛏️ [Action] 採礦中...`);
    await mining.runMineStep(bot, {
        mcData: state.mcData,
        loopConfig: mining.MINING_CONFIG,
        state: {
            ...state,
            markMiningProgress: () => markMiningProgress(bot)
        }
    });

    const after = {
        position: bot.entity ? { ...bot.entity.position } : null,
        digging: Boolean(bot.isDigging),
        target: bot.targetBlock ? bot.targetBlock.position : null
    };

    const moved = after.position && before.position && (
        Math.abs(after.position.x - before.position.x) > 0.01 ||
        Math.abs(after.position.y - before.position.y) > 0.01 ||
        Math.abs(after.position.z - before.position.z) > 0.01
    );

    const actuallyMining = Boolean(after.digging || after.target || moved);
    if (!actuallyMining) {
        //console.log('⚠️ [FSM] 採礦入口判定：本次 tick 內沒有任何有效挖掘活動，可能已經卡在原地。');
    }
}

async function tickStateMachine(bot) {
    if (!state.isLoopRunning || state.isTicking) {
        return;
    }

    state.isTicking = true;

    try {
        // 透過 Rule Engine 選優先序最高的規則
        const rule = pickRuleByPriority(bot);
        if (!rule) {
            console.log('❌ [FSM] No rule matched');
            state.isTicking = false;
            return;
        }

        if (state.currentState !== rule.name) {
            console.log(`\n🔄 [FSM] ${state.currentState} -> ${rule.name}`);
        }

        state.currentState = rule.name;
        await rule.action(bot);
    } catch (err) {
        console.log('❌ [FSM] Tick error:', err && err.message ? err.message : err);
    } finally {
        state.isTicking = false;
    }
}

/**
 * 請求 FSM 在下一輪 tick 優先執行手動存倉流程。
 */
function requestStorage() {
    state.pendingStorage = true;
}

/**
 * 啟動 FSM 主循環與規則引擎。
 * @param {import('mineflayer').Bot} bot
 */
function startLoop(bot) {
    if (state.isLoopRunning && state.tickTimer) {
        console.log(`⚠️ [FSM] 已在運行中，忽略重複啟動`);
        return;
    }

    console.log(`\n🎬 [FSM] === 開始主循環 ===`);
    state.isLoopRunning = true;
    state.pendingStorage = false;
    state.isInWild = false;
    state.collectErrorCount = 0;
    state.damageDetected = false;
    state.enemyDetected = false;
    state.currentState = FSM_STATE.Idle;
    resetMiningIdleState();
    state.mcData = require('minecraft-data')(bot.version);

    // Rule Engine 初始化：預先排序一次，避免每 tick 都重排。
    sortedRules = [...rules].sort((a, b) => b.priority - a.priority);
    console.log(`📋 [FSM] 規則已排序: ${sortedRules.map(r => `${r.name}(${r.priority})`).join(' -> ')}`);

    // 血量監聽採單次安裝，避免重複綁定造成多次觸發。
    installHealthDamageSensor(bot);
    console.log(`💓 [FSM] 血量監聽已安裝`);

    state.tickTimer = setInterval(() => {
        tickStateMachine(bot);
    }, LOOP_CONFIG.tickMs);

    tickStateMachine(bot);
}

/**
 * 停止 FSM 主循環並重置主要狀態。
 */
function stopLoop() {
    // stop 只做狀態重置與計時器清理，不移除事件監聽。
    console.log(`\n🛑 [FSM] === 停止主循環 ===`);
    state.isLoopRunning = false;
    state.isTicking = false;
    state.pendingStorage = false;
    state.enemyDetected = false;
    state.damageDetected = false;
    state.currentState = FSM_STATE.Idle;
    resetMiningIdleState();

    if (state.tickTimer) {
        clearInterval(state.tickTimer);
        state.tickTimer = null;
    }
    console.log(`✅ [FSM] 已清理循環`);
}

module.exports = {
    state,
    startLoop,
    stopLoop,
    requestStorage,
    shouldRtpForMiningStuck,
    runEscape,
    markMiningProgress
};
