// 採礦模組：只負責挖掘流程與相關工具函式，不承擔 FSM 入口。
const { goals } = require('mineflayer-pathfinder');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MINING_CONFIG = {
    noTargetSleepMs: 500,
    nearbySearchDistance: 10,
    nearbySearchCount: 30,
    maxCollectTargets: 8,
    yDiffUpper: 1.5,
    yDiffLower: -2.5,
    collectChestRadius: 3,
    collectItemRadius: 3,
    maxCollectErrorsBeforeRtp: 8,
    collectTimeoutMs: 15000 // ⏱️ 新增：單次挖掘任務最多執行 15 秒，超過就強制中斷
};

// 供 FSM 與採礦流程共用的物品判斷工具。
/**
 * 檢查背包內符合關鍵字的物品數量是否達標。
 * @param {import('mineflayer').Bot} bot
 * @param {string} keyword
 * @param {number} [minCount=1]
 * @returns {boolean}
 */
function hasItem(bot, keyword, minCount = 1) {
    const items = bot.inventory.items().filter((item) => item.name.includes(keyword));
    const totalCount = items.reduce((sum, item) => sum + item.count, 0);
    return totalCount >= minCount;
}

/**
 * 搜集可挖掘泥土目標並依高度差過濾，避免選到過高/過低方塊。
 * @param {import('mineflayer').Bot} bot
 * @param {any} mcData
 * @param {typeof MINING_CONFIG} cfg
 * @returns {Array<any>}
 */
function collectNearbyDirtTargets(bot, mcData, cfg) {
    if (!bot.entity || !bot.entity.position) {
        return [];
    }

    if (bot.targetBlock && bot.targetBlock.position) {
        const targetPos = bot.targetBlock.position;
        const currentPos = bot.entity.position;
        const distance = Math.sqrt(
            (targetPos.x - currentPos.x) ** 2 +
            (targetPos.y - currentPos.y) ** 2 +
            (targetPos.z - currentPos.z) ** 2
        );

        if (distance > cfg.nearbySearchDistance + 4) {
            bot.targetBlock = null;
        }
    }

    const allDirtPositions = bot.findBlocks({
        matching: mcData.blocksByName.dirt.id,
        maxDistance: cfg.nearbySearchDistance,
        count: cfg.nearbySearchCount
    });

    const currentBotY = bot.entity.position.y;
    const filteredPositions = allDirtPositions.filter((pos) => {
        const yDiff = pos.y - currentBotY;
        return yDiff <= cfg.yDiffUpper && yDiff >= cfg.yDiffLower;
    }).slice(0, cfg.maxCollectTargets);

    return filteredPositions.map((pos) => bot.blockAt(pos)).filter(Boolean);
}

async function equipShovelIfNeeded(bot) {
    const heldItem = bot.heldItem;
    if (heldItem && heldItem.name.includes('shovel')) {
        return;
    }

    const shovel = bot.inventory.items().find((item) => item.name.includes('shovel'));
    if (shovel) {
        try {
            await bot.equip(shovel, 'hand');
        } catch (err) {
        }
    }
}

function clearMiningRuntimeState(bot) {
    try {
        if (bot) {
            bot.targetBlock = null;
            bot.isDigging = false;
            if (typeof bot.stopDigging === 'function') {
                bot.stopDigging();
            }
            if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') {
                bot.pathfinder.stop();
            }
        }
    } catch (e) { }

    try {
        if (bot && bot.collectBlock) {
            if (bot.collectBlock.customEvents && typeof bot.collectBlock.customEvents.removeAllListeners === 'function') {
                bot.collectBlock.customEvents.removeAllListeners();
            }
            if (bot.collectBlock.targets && typeof bot.collectBlock.targets.clear === 'function') {
                bot.collectBlock.targets.clear();
            }
            bot.collectBlock.currentTarget = null;
            bot.collectBlock.collecting = false;
        }
    } catch (e) { }
}

function requireMiningRuntimeState(runtime) {
    if (!runtime || !runtime.state) {
        throw new Error('runMineStep requires runtime.state callbacks.');
    }

    const requiredCallbacks = [
        'markMiningProgress',
        'setIsInWild',
        'resetCollectErrorCount',
        'incrementCollectErrorCount',
        'setTargetCount'
    ];

    for (const callbackName of requiredCallbacks) {
        if (typeof runtime.state[callbackName] !== 'function') {
            throw new Error(`runMineStep requires runtime.state.${callbackName}() callback.`);
        }
    }

    return runtime.state;
}

function markRuntimeMiningProgress(runtimeState, bot) {
    runtimeState.markMiningProgress(bot);
}

/**
 * 執行單一方塊的導航與挖掘，並回傳可供 FSM 判斷的狀態。
 * @param {import('mineflayer').Bot} bot
 * @param {any} block
 * @param {typeof MINING_CONFIG} cfg
 * @param {{markMiningProgress:(bot: import('mineflayer').Bot)=>void}} runtimeState
 * @returns {Promise<{status:string, error?:string}>}
 */
async function mineSingleTarget(bot, block, cfg, runtimeState) {
    if (!block || !block.position) {
        return { status: 'invalid' };
    }

    const pos = block.position;
    const blockSummary = `${pos.x},${pos.y},${pos.z}`;
    console.log(`[Mine] 準備挖方塊 ${blockSummary}`);

    bot.targetBlock = block;

    try {
        await equipShovelIfNeeded(bot);

        if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') {
            try {
                bot.pathfinder.stop();
            } catch (e) { }
        }

        if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') {
            try {
                bot.pathfinder.setGoal(null);
            } catch (e) { }
        }

        const hasShovelNow = hasItem(bot, 'shovel', 1);
        if (!hasShovelNow) {
            console.log('[Mine] 沒有工具，停止挖掘。');
            return { status: 'no_shovel' };
        }

        if (!bot.pathfinder || typeof bot.pathfinder.goto !== 'function') {
            console.log('[Mine] pathfinder 不可用，停止挖掘。');
            return { status: 'pathfinder_unavailable' };
        }

        const pathTimeoutMs = Math.min(cfg.collectTimeoutMs || 15000, 5000);
        console.log(`[Mine] 開始尋路到方塊 ${blockSummary}，timeout=${pathTimeoutMs}ms`);

        try {
            await Promise.race([
                bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world)),
                new Promise((_, reject) => setTimeout(() => reject(new Error('PathTimeout')), pathTimeoutMs))
            ]);
        } catch (err) {
            const errorMessage = err && err.message ? err.message : String(err);
            if (errorMessage.includes('stopped') || errorMessage.includes('stop')) {
                console.log(`[Mine] 尋路被中斷: ${errorMessage}`);
                return { status: 'path_stopped', error: errorMessage };
            }
            throw err;
        }

        console.log(`[Mine] 到達方塊 ${blockSummary}，開始 dig`);

        const digTimeoutMs = Math.min(cfg.collectTimeoutMs || 15000, 5000);
        await Promise.race([
            bot.dig(block),
            new Promise((_, reject) => setTimeout(() => reject(new Error('DigTimeout')), digTimeoutMs))
        ]);

        console.log(`[Mine] 方塊挖掘完成 ${blockSummary}`);
        markRuntimeMiningProgress(runtimeState, bot);
        return { status: 'success' };
    } catch (err) {
        const errorMessage = err && err.message ? err.message : String(err);
        console.log(`[Mine] 挖方塊失敗: ${errorMessage}`);
        return { status: 'failed', error: errorMessage };
    } finally {
        clearMiningRuntimeState(bot);
    }
}

/**
 * 採礦主流程單步：搜尋目標、嘗試挖掘並更新共享狀態。
 * @param {import('mineflayer').Bot} bot
 * @param {{
 *   mcData:any,
 *   loopConfig?:typeof MINING_CONFIG,
 *   state: {
 *     markMiningProgress: (bot: import('mineflayer').Bot) => void,
 *     setIsInWild: (isInWild:boolean) => void,
 *     resetCollectErrorCount: () => void,
 *     incrementCollectErrorCount: () => number,
 *     setTargetCount: (count:number) => void
 *   }
 * }} runtime
 * @returns {Promise<void>}
 */
async function runMineStep(bot, runtime) {
    const runtimeState = requireMiningRuntimeState(runtime);
    const cfg = runtime.loopConfig || MINING_CONFIG;
    const targets = collectNearbyDirtTargets(bot, runtime.mcData, cfg);
    const position = bot.entity && bot.entity.position
        ? `${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}`
        : 'unknown';

    console.log(`[Mine] runMineStep start: targetCount=${targets.length}, position=${position}`);

    // 回報目標數量給 FSM（供 shouldRtpForMiningStuck 判斷）
    runtimeState.setTargetCount(targets.length);

    /*
    if (targets.length === 0) {
        console.log('⚠️ [FSM] 區塊內泥土已挖完，/rtp至新地點。');
        runtimeState.setIsInWild(false);
        return;
    }
    */

    try {
        const timeoutMs = cfg.collectTimeoutMs || 15000;
        const targetSummary = targets.slice(0, 3).map((target) => target && target.position ? `${target.position.x},${target.position.y},${target.position.z}` : 'unknown').join(' | ');
        console.log(`[Mine] 開始手動挖掘: timeout=${timeoutMs}ms, targets=${targets.length}, firstTargets=${targetSummary}`);

        for (const target of targets) {
            const result = await mineSingleTarget(bot, target, cfg, runtimeState);
            if (result.status === 'success') {
                runtimeState.resetCollectErrorCount();
                return;
            }

            if (result.status === 'no_shovel') {
                console.log('⚠️ [FSM] 工具遺失。');
                runtimeState.setIsInWild(false);
                return;
            }

            if (result.status === 'pathfinder_unavailable') {
                console.log('⚠️ [Mine] pathfinder 不可用，停止本輪。');
                runtimeState.setIsInWild(false);
                return;
            }
        }

        const collectErrorCount = runtimeState.incrementCollectErrorCount();
        if (collectErrorCount >= cfg.maxCollectErrorsBeforeRtp) {
            console.log('⚠️ [FSM] 連續採集異常，切換到新地點 /rtp。');
            runtimeState.setIsInWild(false);
            runtimeState.resetCollectErrorCount();
        }
    } catch (err) {
        const errorMessage = err && err.message ? err.message : String(err);
        console.log(`[Mine] runMineStep catch，error=`, errorMessage);
        clearMiningRuntimeState(bot);
        if (errorMessage === 'MiningTimeout') {
            console.log(`⏳ [Mine] 採集超時 (${(cfg.collectTimeoutMs || 15000) / 1000}秒)，強制釋放控制權給 FSM。`);
            return;
        }
    }
}

module.exports = {
    MINING_CONFIG,
    hasItem,
    runMineStep
};