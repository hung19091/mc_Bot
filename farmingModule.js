let isFarming = false;
let farmInterval = null;

/**
 * 骨粉流專用定點站樁農夫模組
 */
function startFarmingLoop(bot, targetCrop, config) {
    if (isFarming) return;
    isFarming = true;
    console.log(`🌱 [定點農夫] 骨粉流自動採收 【${targetCrop}】 啟動！`);

    let internalCropName = targetCrop;

    const maxAge = (internalCropName === 'nether_wart') ? 3 : 7;
    const vec3 = require('vec3');

    if (!config || !config.point || !config.coordinates) {
        console.log('❌ [定點農夫] 錯誤：配置缺少 point 或 coordinates！');
        isFarming = false;
        return;
    }

    const standPos = new vec3(config.point.x, config.point.y, config.point.z);
    const targetPos = new vec3(config.coordinates.x, config.coordinates.y, config.coordinates.z);

    let logCounter = 0;
    let lookTimeout = 0;

    // 將 bot.on 移出 setInterval，在啟動模組時「只註冊一次」
    currentMessageListener = function (message) {
        if (message.includes('獲得了') && message.includes('任務獎勵')) {
            console.log('🎉 [定點農夫] 偵測到任務完成訊息！');

            // 1. 先停掉農夫自己
            stopFarmingLoop(bot);

            // 2. 執行外部傳進來的通知（讓主程式重設狀態機）
            if (typeof onFinished === 'function') {
                onFinished();
            }
        }
    };
    bot.on('messagestr', currentMessageListener);

    farmInterval = setInterval(async () => {
        // 💡 修正點 1：放寬安全站立點限制。只要在 2 格內都可以直接採收！
        // 如果超過 2 格（通常是被怪推走），才啟動路徑尋找修正。
        const currentDistance = bot.entity.position.distanceTo(standPos);
        if (currentDistance > 2.0) {
            if (!bot.pathfinder.isMoving()) {
                console.log(`⚠️ [定點農夫] 偏離過遠 (${currentDistance.toFixed(2)}格)，正在導航回站立點...`);
                const { GoalBlock } = require('mineflayer-pathfinder').goals;
                const movements = new (require('mineflayer-pathfinder').Movements)(bot, require('minecraft-data')(bot.version));
                movements.canDig = false;
                bot.pathfinder.setMovements(movements);
                bot.pathfinder.setGoal(new GoalBlock(standPos.x, standPos.y, standPos.z));
            }
            return; // 偏離過遠時才不採收
        }

        // 💡 修正點 3：降低看方塊的頻率，每 1 秒（每5次循環）看一次就好，防止 lookAt 阻塞事件監聽
        lookTimeout++;
        if (lookTimeout % 5 === 0) {
            bot.lookAt(targetPos.offset(0.5, 0.3, 0.5), true); // 第二個參數 true 代表瞬間轉頭不緩衝
        }

        // 3. 取得作物方塊狀態
        const currentBlock = bot.blockAt(targetPos);

        logCounter++;
        if (logCounter % 15 === 0 && currentBlock) {
            console.log(`🔍 [農夫顯微鏡] 目標方塊:【${currentBlock.name}】, 狀態值(metadata):【${currentBlock.metadata}】`);
        }

        if (!currentBlock) return;

        // 💡 修正點 2 的檢查：支援精確對比或包含關係
        if (currentBlock.name !== internalCropName && !currentBlock.name.includes(internalCropName)) {
            // 如果地上的方塊是空氣(air)，代表被採收了但還沒種下去，等待下一輪
            return;
        }

        // 4. 不論是否完全成熟，隔空秒破壞
        if (currentBlock.metadata > 0) {
            try {
                // 如果目前的 pathfinder 還在微調殘留中，強行停止它，專心挖掘
                if (bot.pathfinder.isMoving()) {
                    bot.pathfinder.stop();
                }

                // 第二個參數 true 代表強行無視視線遮擋檢查
                await bot.dig(currentBlock, true);
                console.log(`⚡ [定點農夫] 成功隔空採收成熟的 ${currentBlock.name}！`);
            } catch (err) {
                // 捕捉挖掘衝突 (例如方塊在挖掘途中剛好變了)
            }
        }
    }, 200);
}

function stopFarmingLoop() {
    if (farmInterval) clearInterval(farmInterval);
    isFarming = false;
    console.log('🛑 [定點農夫] 已停止站樁採收。');
}

module.exports = { startFarmingLoop, stopFarmingLoop };