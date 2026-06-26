const config = require('./config');
const farmingModule = require('./farmingModule');

// 💡 調整後的配置結構：現在我們改成主要去比對「目標關鍵字」！
const TASK_CONFIG = {
    // 白名單：根據「目標內容」包含的關鍵字來決定動作
    ALLOWED_TARGETS: {
        //'破壞 泥土': { actionType: 'execute', target: 'go' },
        '成熟收穫 馬鈴薯': {
            actionType: 'warp',
            target: '/warp MikeDaGiGi_4',
            cropName: 'potato',
            point: { x: -2093, y: 46, z: 4064 },
            coordinates: { x: -2091, y: 47, z: 4064 }
        },
        '成熟收穫 蒼白垂絲': {
            actionType: 'warp',
            target: '/warp MikeDaGiGi_4',
            cropName: 'hanging_roots',
            point: { x: -1994, y: 46, z: 4003 },
            coordinates: { x: -1996, y: 48, z: 4003 }
        },
        '成熟收穫 任何農作物': {
            actionType: 'warp',
            target: '/warp MikeDaGiGi_4',
            cropName: 'potato',
            point: { x: -2093, y: 46, z: 4064 },
            coordinates: { x: -2091, y: 47, z: 4064 }
        },




        '成熟收穫 小麥': {
            actionType: 'warp',
            target: '/warp MikeDaGiGi_4',
            cropName: 'wheat',
            coordinates: { x: -10, y: 60, z: 20 }
        },
        '成熟收穫 胡蘿蔔': {
            actionType: 'warp',
            target: '/warp MikeDaGiGi_4',
            cropName: 'carrot',
            coordinates: { x: 50, y: 60, z: 80 }
        },

        // 教學任務，先讓牠 idle 保持在原地
        '宣告領地': { actionType: 'idle' },
        '放置 儲物箱': { actionType: 'idle' }
    },

    // 黑名單：只要「目標」或「任務」包含這些字，一律跳過
    SKIP_KEYWORDS: [
        '黑石',
        '玄武岩',
        '挖取 青金石'
    ]
};

// 💡 引入狀態機
const STATES = {
    IDLE: 'IDLE',         // 閒置/等待中
    TRAVELING: 'TRAVELING', // 正在移動/傳送中
    FARMING: 'FARMING',     // 正在專心採收中
    MINING: 'MINING'        // 正在挖礦/挖土中
};

let currentState = STATES.IDLE;
let isTaskLoopRunning = false;
let checkInterval = null;
let lastSkipTime = 0;
let lastTargetString = ''; // 紀錄上一次的目標字串，用來比對任務是否真的「換了」

/**
 * 深度遍歷 NBT 物件，將所有藏在裡面的 text 提取出來
 */
function extractTextFromNBT(obj) {
    let text = '';
    if (!obj || typeof obj !== 'object') return text;

    // 如果發現有 text 屬性，且它是個字串物件 (prismarine-nbt 格式)
    if (obj.text && obj.text.value) {
        text += obj.text.value + ' ';
    } else if (typeof obj.text === 'string') {
        text += obj.text + ' ';
    }

    // 繼續遞迴尋找子節點
    for (const key in obj) {
        if (obj[key] && typeof obj[key] === 'object') {
            text += extractTextFromNBT(obj[key]);
        }
    }
    return text;
}

/**
 * 針對 Teams 進行結構化掃描，同時抓取「任務」與「目標」
 */
function getCurrentTask(bot) {
    const teams = bot.teams;
    if (!teams) return null;

    let taskName = null;
    let targetName = null;

    // 1. 遍歷每一個獨立的 team 節點，這樣才能保留行與行之間的獨立性
    for (const teamName in teams) {
        const team = teams[teamName];

        // 轉成字串並清理顏色代碼
        const teamStr = JSON.stringify(team).replace(/§[0-9a-fk-or]/gi, '');

        // 只抽取中文字、數字、基本符號與斜線
        const matchChinese = teamStr.match(/[\u4e00-\u9fa5【】\d\/:\s]+/g);
        if (!matchChinese) continue;

        const cleanLine = matchChinese.join('').replace(/\s+/g, ' ').trim();

        // 2. 抓取【任務】行
        if (cleanLine.includes('任務') && !taskName) {
            // 支援格式："任務 【1/15】宣告領地" 或 "任務 【地獄工程 IV】"
            // 先拿到「任務」後面的所有字
            const taskMatch = cleanLine.match(/任務\s*[:：]?\s*(.+)/);
            if (taskMatch && taskMatch[1]) {
                taskName = taskMatch[1].trim();
            }
        }

        // 3. 抓取【目標】行
        if (cleanLine.includes('目標') && !targetName) {
            // 支援格式："目標 放置 儲物箱 0 / 1" 或 "目標: 破壞 黑石 0 / 256"
            const targetMatch = cleanLine.match(/目標\s*[:：]?\s*(.+)/);
            if (targetMatch && targetMatch[1]) {
                targetName = targetMatch[1].trim();
            }
        }
    }

    // 4. 如果兩個都抓到了（或者至少抓到任務是無），就整合輸出
    if (taskName || targetName) {
        // 判定是否為無任務狀態
        if (taskName && (taskName.includes('【無】') || taskName.includes('未接'))) {
            return { task: '無', target: '無' };
        }

        return {
            task: taskName || '未知任務',
            target: targetName || '未知目標'
        };
    }

    return null;
}

/**
 * 模擬 SHIFT + 右鍵點擊地板（安全空手版）
 */
async function acceptNewTask(bot) {
    console.log('✨ [任務] 偵測到當前無任務，嘗試接取任務...');
    bot.setQuickBarSlot(4);
    await bot.waitForTicks(2);
    await bot.lookAt(bot.entity.position.offset(0, -1, 0.5));
    bot.setControlState('sneak', true);
    await bot.waitForTicks(2);

    const block = bot.blockAt(bot.entity.position.offset(0, -1, 0.5));
    if (block) {
        try {
            bot.swingArm('right');
            await bot.activateBlock(block);
            console.log(`👌 [任務] 已空手執行 SHIFT+右鍵 點擊地板 (方塊: ${block.name})`);
        } catch (err) {
            console.log('❌ [任務] 點擊地面失敗：', err.message);
        }
    }
    await bot.waitForTicks(5);
    bot.setControlState('sneak', false);
}

function startTaskLoop(bot, miningModule) {
    if (isTaskLoopRunning) return;
    isTaskLoopRunning = true;
    console.log('🔄 [任務系統] 狀態機自動管理已啟動。');

    async function runCheck() {
        if (!isTaskLoopRunning) return;

        try {
            if (currentState === STATES.TRAVELING) {
                console.log('⏳ [任務系統] 狀態：傳送/移動中，暫不打擾。');
                checkInterval = setTimeout(runCheck, 5000);
                return;
            }

            const taskInfo = getCurrentTask(bot);
            if (!taskInfo) {
                checkInterval = setTimeout(runCheck, 5000);
                return;
            }

            // 狀況 1：無任務
            if (taskInfo.task === '無') {
                if (currentState !== STATES.IDLE) {
                    farmingModule.stopFarmingLoop();
                    if (miningModule) miningModule.stopLoop(bot);
                    currentState = STATES.IDLE;
                    lastTargetString = '';
                }
                await acceptNewTask(bot);
                checkInterval = setTimeout(runCheck, 5000);
                return;
            }

            // 1. 核心過濾
            const cleanTargetText = taskInfo.target
                .replace(/[\d\/]+/g, '')
                .replace(/[:\s【】]+/g, '')
                .trim();

            // 2. 關鍵鎖定：如果狀態已經是 FARMING，且純文字目標沒變，直接 return
            if (currentState === STATES.FARMING && lastTargetString === cleanTargetText && cleanTargetText !== '') {
                checkInterval = setTimeout(runCheck, 5000);
                return;
            }

            console.log(`----------------------------------------`);
            console.log(`📋 [任務狀態] 目前狀態：【${currentState}】`);
            console.log(`🎯 [任務追蹤] 目前目標：【${taskInfo.target}】(過濾後: ${cleanTargetText})`);
            console.log(`----------------------------------------`);

            // 狀況 2：黑名單與未定義跳過
            const shouldSkip = TASK_CONFIG.SKIP_KEYWORDS.some(keyword =>
                taskInfo.task.includes(keyword) || taskInfo.target.includes(keyword)
            );

            let allowedAction = null;
            for (const key in TASK_CONFIG.ALLOWED_TARGETS) {
                if (taskInfo.target.includes(key)) {
                    allowedAction = TASK_CONFIG.ALLOWED_TARGETS[key];
                    break;
                }
            }

            if (shouldSkip) {
                const now = Date.now();
                if (now - lastSkipTime > 20000) {
                    console.log(`⚠️ [任務決策] 不符效益，執行 /qskip...`);
                    farmingModule.stopFarmingLoop();
                    bot.chat('/qskip');
                    lastSkipTime = now;
                    currentState = STATES.IDLE;
                    lastTargetString = '';
                }
                checkInterval = setTimeout(runCheck, 5000);
                return;
            }

            if (!allowedAction) {
                console.log(`⚠️ [任務決策] 未包含在黑名單/白名單，請手動新增任務清單`);
                return;
            }

            // 3. 狀況 3：有目標且需要傳送
            if (allowedAction.actionType === 'warp') {
                currentState = STATES.TRAVELING;
                farmingModule.stopFarmingLoop();

                console.log(`🚀 [任務動作] 執行傳送指令：${allowedAction.target}`);
                bot.chat(allowedAction.target);

                // 給予充足的 4 秒傳送與區塊載入時間
                await new Promise(resolve => setTimeout(resolve, 4000));

                if (allowedAction.point) {
                    console.log(`🦅 [任務動作] 啟動導航...`);

                    const { GoalBlock } = require('mineflayer-pathfinder').goals;
                    const movements = new (require('mineflayer-pathfinder').Movements)(bot, require('minecraft-data')(bot.version));

                    // 魔改飛行參數
                    movements.gravity = 0;
                    movements.flyingCost = 1;
                    movements.canDig = false;

                    bot.pathfinder.setMovements(movements);

                    const vec3 = require('vec3');
                    const standPos = new vec3(allowedAction.point.x, allowedAction.point.y, allowedAction.point.z);
                    bot.pathfinder.setGoal(new GoalBlock(standPos.x, standPos.y, standPos.z));

                    // 監聽距離
                    await new Promise((resolve) => {
                        let failSafeCounter = 0;

                        const timer = setInterval(() => {
                            const distance = bot.entity.position.distanceTo(standPos);
                            failSafeCounter++;

                            // 如果距離 1.5 格內，或是高度很接近且平面距離很近，就算抵達
                            if (distance <= 1.5) {
                                console.log(`📌 [導航] 物理距離確認抵達！(剩餘 ${distance.toFixed(2)} 格)`);
                                clearInterval(timer);
                                resolve();
                                return;
                            }

                            // 超時安全鎖 30 秒
                            if (failSafeCounter >= 150) {
                                console.log(`⏳ [導航] 導航超時安全鎖觸發，強制就地交棒！`);
                                clearInterval(timer);
                                resolve();
                                return;
                            }
                        }, 200);
                    });

                    // 徹底重設 Pathfinder，並還原 Movements 物理環境！
                    console.log(`🔄 [導航] 正在解除導航模式並釋放 BOT 物理控制權...`);
                    bot.pathfinder.stop(); // 使用 stop 徹底中斷尋路事件
                    bot.pathfinder.setGoal(null);

                    // 還原成正常的生存模式走路參數，允許 BOT 破壞方塊與受重力影響
                    const defaultMovements = new (require('mineflayer-pathfinder').Movements)(bot, require('minecraft-data')(bot.version));
                    bot.pathfinder.setMovements(defaultMovements);

                    // 確保BOT沒有卡在飄浮狀態，關閉跳躍控制
                    bot.setControlState('jump', false);
                    await bot.waitForTicks(5);
                }

                // 確保切換狀態
                lastTargetString = cleanTargetText;
                currentState = STATES.FARMING;

                console.log('🔓 [任務系統] 狀態已成功切換為 FARMING！');

                // 💡 修正點 3：用 setImmediate 或是稍微 delay 1 顯示格，給予底層物理引擎釋放控制權的時間
                setImmediate(() => {
                    // 💡 關鍵傳參：第四個參數傳入一個箭頭函式 () => { ... }
                    farmingModule.startFarmingLoop(bot, allowedAction.cropName, allowedAction, () => {
                        console.log('🧠 [任務系統] 收到農夫模組回報完工！正在重設狀態機...');

                        // 更新主程式的狀態機，讓一切歸零，等待下一次自動檢查
                        if (checkInterval) clearTimeout(checkInterval);
                        currentState = STATES.IDLE;
                        lastTargetString = '';

                        // 讓 BOT 完全立定，清除殘留的 pathfinder 尋路與按鍵
                        bot.pathfinder.stop();
                        bot.pathfinder.setGoal(null);
                        bot.clearControlStates();
                    });
                });
            }

            else if (allowedAction.actionType === 'execute' && allowedAction.target === 'go') {
                lastTargetString = cleanTargetText;
                currentState = STATES.MINING;
                if (!miningModule.state.isLoopRunning) {
                    miningModule.state.isLoopRunning = true;
                    miningModule.startLoop(bot);
                }
            }

        } catch (error) {
            console.error('❌ [任務系統] 迴圈執行發生異常:', error);
        }

        checkInterval = setTimeout(runCheck, 5000);
    }

    checkInterval = setTimeout(runCheck, 5000);
}

function stopTaskLoop() {
    if (checkInterval) clearTimeout(checkInterval); // 💡 配合 setTimeout 改用 clearTimeout
    isTaskLoopRunning = false;
    currentState = STATES.IDLE;
    lastTargetString = '';
    console.log('🛑 [任務] 任務自動管理系統已停止。');
}

module.exports = { startTaskLoop, stopTaskLoop, getCurrentTask };