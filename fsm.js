const storage = require('./storage');
const supplies = require('./supplies');
const mining = require('./mining');

// FSM 協調層參數：只放與狀態決策相關的常數。
const LOOP_CONFIG = {
    tickMs: 500,
    teleportWaitMs: 7000,
    hungryThreshold: 15,
    steakMinToStart: 20,
    defaultHealth: 20,
    hostileDistance: 12
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
    currentState: FSM_STATE.Idle
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

function detectNearbyHostile(bot) {
    if (!bot.entity || !bot.entity.position) {
        return false;
    }

    const entities = Object.values(bot.entities || {});
    return entities.some((entity) => {
        if (!entity || entity.type !== 'mob' || !entity.name || !entity.position) {
            return false;
        }

        if (!HOSTILE_MOBS.has(entity.name)) {
            return false;
        }

        return bot.entity.position.distanceTo(entity.position) <= LOOP_CONFIG.hostileDistance;
    });
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
            state.damageDetected = true;
            console.log(`⚠️ [FSM] 受傷偵測！血量: ${state.lastHealth} -> ${currentHealth}`);
        }

        state.lastHealth = currentHealth;
    });
}

function hasThreat() {
    return state.damageDetected || state.enemyDetected;
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

async function runEscape(bot) {
    // 逃跑統一策略：立即 /rtp，並清掉威脅相關旗標。
    console.log(`🏃 [Action] 逃跑中...`);
    bot.pathfinder.stop();
    bot.chat(RTP_COMMAND);
    await sleep(LOOP_CONFIG.teleportWaitMs);
    state.isInWild = true;
    state.damageDetected = false;
    state.enemyDetected = false;
    state.collectErrorCount = 0;
    console.log(`✅ [Action] 逃跑完成，已隨機傳送`);
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
    console.log(`⛏️ [Action] 採礦中...`);
    await mining.runMineStep(bot, {
        mcData: state.mcData,
        loopConfig: mining.MINING_CONFIG,
        state
    });
}

async function tickStateMachine(bot) {
    if (!state.isLoopRunning || state.isTicking) {
        return;
    }

    state.isTicking = true;

    try {
        state.enemyDetected = detectNearbyHostile(bot);
        if (state.enemyDetected) {
            console.log(`⚠️ [Detect] 周邊偵測到敵對生物！`);
        }

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

function requestStorage() {
    state.pendingStorage = true;
}

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

function stopLoop() {
    // stop 只做狀態重置與計時器清理，不移除事件監聽。
    console.log(`\n🛑 [FSM] === 停止主循環 ===`);
    state.isLoopRunning = false;
    state.isTicking = false;
    state.pendingStorage = false;
    state.enemyDetected = false;
    state.damageDetected = false;
    state.currentState = FSM_STATE.Idle;

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
    requestStorage
};
