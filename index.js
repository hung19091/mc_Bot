const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;

const config = require('./config');
const fsm = require('./fsm');

// 創建 BOT 實例
const bot = mineflayer.createBot(config.BOT_OPTIONS);

// 載入套件
bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);

bot.once('spawn', () => {
  console.log('🤖 [系統] BOT 已經成功進入廢土伺服器！');

  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);

  bot.pathfinder.setMovements(defaultMove);

  console.log(`📡 [系統] 正在等待主人 ${config.MY_MASTER_ID} 的私訊指令...`);
});

function isFromMasterPrivateMessage(msg) {
  const isFromMaster = msg.includes(config.MY_MASTER_ID);
  const isPrivateMessage = msg.includes('說') || msg.includes('私訊') || msg.includes('->') || msg.includes('密語') || msg.includes('w');
  return isFromMaster && isPrivateMessage;
}

function isTeleportRequest(msg) {
  return msg.includes(config.MY_MASTER_ID) && (msg.includes('請求') || msg.includes('傳送') || msg.toLowerCase().includes('tpa'));
}

// ==================== 功能：監聽來自你的私訊 ====================
bot.on('messagestr', (message, position) => {
  const msg = message.trim();
  console.log(msg);

  // 如果是 BOT 自己的名字出現在發言者位置，直接忽略
  if (msg.startsWith("[您 ->")) return;

  if (isTeleportRequest(msg)) {
    bot.chat('/tpaccept');
    return;
  }

  if (isFromMasterPrivateMessage(msg)) {
    const lowerMsg = msg.toLowerCase();

    // 1. 啟動狀態機循環
    if (lowerMsg.includes('go')) {
      if (fsm.state.isLoopRunning) {
        bot.chat(`/m ${config.MY_MASTER_ID} 我已經在執行中了。`);
        return;
      }

      bot.chat(`/m ${config.MY_MASTER_ID} 收到，準備開始挖土。`);
      console.log('🚀 [指令] 啟動狀態機主循環。');
      fsm.startLoop(bot);
      return;
    }

    // 2. 觸發狀態機中的儲存流程
    if (lowerMsg.includes('storage')) {
      if (!fsm.state.isLoopRunning) {
        fsm.startLoop(bot);
      }

      fsm.requestStorage();
      bot.chat(`/m ${config.MY_MASTER_ID} 收到，準備儲存物品。`);
      return;
    }

    // 3. 停止狀態機循環
    if (lowerMsg.includes('stop')) {
      fsm.stopLoop();
      bot.chat(`/m ${config.MY_MASTER_ID} 收到，已停止工作。`);
    }
  }
});

// ==================== 基礎錯誤與斷線處理 ====================
bot.on('error', (err) => {
  if (err.message && err.message.includes('Read error')) return;
  console.log('❌ [BOT錯誤]：', err);
});

bot.on('kicked', (reason) => console.log('🚪 [斷線] 被伺服器踢出：', reason));