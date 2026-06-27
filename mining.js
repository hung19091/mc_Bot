// 採礦模組：只負責挖掘流程與相關工具函式，不承擔 FSM 入口。
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
function hasItem(bot, keyword, minCount = 1) {
    const items = bot.inventory.items().filter((item) => item.name.includes(keyword));
    const totalCount = items.reduce((sum, item) => sum + item.count, 0);
    return totalCount >= minCount;
}

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

async function runMineStep(bot, runtime) {
    const cfg = runtime.loopConfig || MINING_CONFIG;
    const targets = collectNearbyDirtTargets(bot, runtime.mcData, cfg);

    if (targets.length === 0) {
        await sleep(cfg.noTargetSleepMs);
        return;
    }

    try {
        await equipShovelIfNeeded(bot);

        // ⏱️ 核心改動：建立一個超時 Promise
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('MiningTimeout')), cfg.collectTimeoutMs || 15000)
        );

        // 使用 Promise.race，只要 collect 逾時或報錯，任何一個先發生就結束
        await Promise.race([
            bot.collectBlock.collect(targets, {
                ignoreFrame: true,
                count: targets.length,
                chestRadius: cfg.collectChestRadius,
                itemRadius: cfg.collectItemRadius
            }),
            timeoutPromise
        ]);

        runtime.state.collectErrorCount = 0;
    } catch (err) {
        console.log('⚠️ [FSM] 發生錯誤。err.message:', err.message);
        // 🚨 發生錯誤或超時，必須立即清理 bot 當前的動作，避免底層行為繼續殘留
        try {
            bot.pathfinder.stop();
            if (typeof bot.stopDigging === 'function') bot.stopDigging();
        } catch (e) { }

        if (err.message === 'MiningTimeout') {
            console.log(`⏳ [Mine] 採集超時 (${(cfg.collectTimeoutMs || 15000) / 1000}秒)，強制釋放控制權給 FSM。`);
            // 超時不算嚴重錯誤，交給 FSM 的 20秒 發呆判定去決定要不要 RTP
            return;
        }

        // 工具遺失時交回 FSM 後勤分支處理
        const hasShovelNow = hasItem(bot, 'shovel', 1);
        if (!hasShovelNow) {
            console.log('⚠️ [FSM] 工具遺失。');
            runtime.state.isInWild = false;
            return;
        }

        runtime.state.collectErrorCount += 1;
        if (runtime.state.collectErrorCount >= cfg.maxCollectErrorsBeforeRtp) {
            console.log('⚠️ [FSM] 連續採集異常，切換到新地點 /rtp。');
            runtime.state.isInWild = false;
            runtime.state.collectErrorCount = 0;
        }
    }
}

module.exports = {
    MINING_CONFIG,
    hasItem,
    runMineStep
};