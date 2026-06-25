const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;

const config = require('./config');
const mining = require('./mining');
const storage = require('./storage');

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

// ==================== 功能：監聽來自你的私訊 ====================
bot.on('messagestr', (message, position) => {
  const msg = message.trim();

  // 如果是 BOT 自己的名字出現在發言者位置，直接忽略
  if (msg.startsWith(config.BOT_OPTIONS.username)) return;

  const isFromMaster = msg.includes(config.MY_MASTER_ID);
  const isPrivateMessage = msg.includes('說') || msg.includes('私訊') || msg.includes('->') || msg.includes('密語') || msg.includes('w');

  if (isFromMaster && isPrivateMessage) {
    const lowerMsg = msg.toLowerCase();

    // 1. 執行 go（挖土）
    if (lowerMsg.includes('go')) {
      if (mining.state.isLoopRunning) {
        bot.chat(`/m ${config.MY_MASTER_ID} 我已經在挖土了，不要催我！`);
        return;
      }

      bot.chat(`/m ${config.MY_MASTER_ID} 收到指令！立即開始隨機傳送並挖泥土。`);
      console.log(`🚀 [指令] 偵測到主人私訊關鍵字，啟動主循環！`);

      mining.state.isLoopRunning = true;
      mining.state.hasNotifiedNoShovel = false;
      mining.startLoop(bot);
    }

    // 2. 執行 storage（清空背包到告示牌箱子）
    else if (lowerMsg.includes('storage')) {
      bot.chat(`/m ${config.MY_MASTER_ID} 收到儲存指令，正在尋找 ${config.BOT_OPTIONS.username} 的告示牌箱子...`);
      storage.storeAllItemsToSignChest(bot);
    }
  }
});

// ==================== 功能：自動同意 TPA ====================
bot.on('messagestr', (message, position) => {
  if (message.includes(config.MY_MASTER_ID) && (message.includes('請求') || message.includes('傳送'))) {
    bot.chat('/tpaccept');
  }

  console.log(message);
});

// ==================== 基礎錯誤與斷線處理 ====================
bot.on('error', (err) => {
  if (err.message && err.message.includes('Read error')) return;
  console.log('❌ [BOT錯誤]：', err);
});


bot.on('kicked', (reason) => console.log('🚪 [斷線] 被伺服器踢出：', reason));