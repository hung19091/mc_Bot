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
    maxCollectErrorsBeforeRtp: 8
};

// 供 FSM 與採礦流程共用的物品判斷工具。
function hasItem(bot, keyword, minCount = 1) {
    const items = bot.inventory.items().filter((item) => item.name.includes(keyword));
    const totalCount = items.reduce((sum, item) => sum + item.count, 0);
    return totalCount >= minCount;
}

function collectNearbyDirtTargets(bot, mcData, cfg) {
    // 只挑選合理高度差的目標，降低路徑失敗與卡地形機率。
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
        await bot.collectBlock.collect(targets, {
            ignoreFrame: true,
            count: targets.length,
            chestRadius: cfg.collectChestRadius,
            itemRadius: cfg.collectItemRadius
        });

        runtime.state.collectErrorCount = 0;
    } catch (err) {
        // 工具遺失時交回 FSM 後勤分支處理，不在採礦層硬補。
        const hasShovelNow = hasItem(bot, 'shovel', 1);
        if (!hasShovelNow) {
            runtime.state.isInWild = false;
            return;
        }

        runtime.state.collectErrorCount += 1;
        if (runtime.state.collectErrorCount >= cfg.maxCollectErrorsBeforeRtp) {
            // 多次採集異常時，標記離開野外讓 FSM 重新 /rtp 轉點。
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
