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

function decideNextState(bot) {
    // 決策優先序：生存 > 後勤 > 工作。
    if (hasThreat()) {
        return FSM_STATE.Escape;
    }

    if (shouldEat(bot)) {
        return FSM_STATE.Eat;
    }

    if (state.pendingStorage) {
        return FSM_STATE.ManualStorage;
    }

    if (needSupplies(bot)) {
        return FSM_STATE.Supply;
    }

    if (isInventoryFull(bot)) {
        return FSM_STATE.InventoryStorage;
    }

    if (!state.isInWild) {
        return FSM_STATE.EnsureWild;
    }

    return FSM_STATE.Mine;
}

async function runEscape(bot) {
    // 逃跑統一策略：立即 /rtp，並清掉威脅相關旗標。
    bot.pathfinder.stop();
    bot.chat(RTP_COMMAND);
    await sleep(LOOP_CONFIG.teleportWaitMs);
    state.isInWild = true;
    state.damageDetected = false;
    state.enemyDetected = false;
    state.collectErrorCount = 0;
}

async function runEat(bot) {
    const steak = bot.inventory.items().find((item) => item.name === 'cooked_beef');
    if (!steak) {
        return;
    }

    bot.pathfinder.stop();
    await bot.equip(steak, 'hand');
    await bot.consume();
}

async function runManualStorage(bot) {
    // 手動存倉完成後會重置到非野外，讓流程重新走補給/出發判斷。
    bot.chat(WARP_BASE_COMMAND);
    await sleep(LOOP_CONFIG.teleportWaitMs);
    await storage.storeAllItemsToSignChest(bot, '倉儲區');

    const ok = await supplies.checkAndSupply(bot);
    if (!ok) {
        state.pendingStorage = false;
        stopLoop();
        return;
    }

    state.pendingStorage = false;
    state.isInWild = false;
}

async function runSupply(bot) {
    const ready = await supplies.checkAndSupply(bot);
    if (!ready) {
        stopLoop();
        return;
    }

    state.isInWild = false;
}

async function runInventoryStorage(bot) {
    bot.chat(WARP_BASE_COMMAND);
    await sleep(LOOP_CONFIG.teleportWaitMs);
    await storage.storeAllItemsToSignChest(bot, '倉儲區');

    const ready = await supplies.checkAndSupply(bot);
    if (!ready) {
        stopLoop();
        return;
    }

    state.isInWild = false;
    state.collectErrorCount = 0;
}

async function runEnsureWild(bot) {
    bot.pathfinder.stop();
    bot.chat(RTP_COMMAND);
    await sleep(LOOP_CONFIG.teleportWaitMs);
    state.isInWild = true;
    state.collectErrorCount = 0;
}

async function runMine(bot) {
    // 採礦細節委派給 mining 模組，FSM 只負責調度。
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
        state.currentState = decideNextState(bot);

        switch (state.currentState) {
            case FSM_STATE.Escape:
                await runEscape(bot);
                break;
            case FSM_STATE.Eat:
                await runEat(bot);
                break;
            case FSM_STATE.ManualStorage:
                await runManualStorage(bot);
                break;
            case FSM_STATE.Supply:
                await runSupply(bot);
                break;
            case FSM_STATE.InventoryStorage:
                await runInventoryStorage(bot);
                break;
            case FSM_STATE.EnsureWild:
                await runEnsureWild(bot);
                break;
            case FSM_STATE.Mine:
                await runMine(bot);
                break;
            default:
                break;
        }
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
        return;
    }

    state.isLoopRunning = true;
    state.pendingStorage = false;
    state.isInWild = false;
    state.collectErrorCount = 0;
    state.damageDetected = false;
    state.enemyDetected = false;
    state.currentState = FSM_STATE.Idle;
    state.mcData = require('minecraft-data')(bot.version);

    // 血量監聽採單次安裝，避免重複綁定造成多次觸發。
    installHealthDamageSensor(bot);

    state.tickTimer = setInterval(() => {
        tickStateMachine(bot);
    }, LOOP_CONFIG.tickMs);

    tickStateMachine(bot);
}

function stopLoop() {
    // stop 只做狀態重置與計時器清理，不移除事件監聽。
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
}

module.exports = {
    state,
    startLoop,
    stopLoop,
    requestStorage
};
