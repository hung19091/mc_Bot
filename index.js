const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;

// ==================== 設定區 ====================
const MY_MASTER_ID = 'HIRO_QQX';       // 你的主要遊戲 ID
const WARP_BASE_COMMAND = '/warp XXX'; // 回基地的指令 (請把 XXX 改成你基地的 warp 名稱)
const CHEST_POSITION = [100, 64, -200]; // 基地箱子的精確座標 [X, Y, Z]
// ================================================

let isLoopRunning = false; // 用來標記目前自動挖土循環是否正在執行中
let hasNotifiedNoShovel = false; // 用來確保沒有鏟子時只通知一次

const bot = mineflayer.createBot({
  host: 'jp.mcfallout.net', 
  port: 25565, 
  username: 'HIRO_NAGA', 
  auth: 'microsoft',
  version: '1.20.4'
});

// 載入導航與採集套件
bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);

bot.once('spawn', () => {
  console.log('🤖 [系統] BOT 已經成功進入廢土伺服器！');
  
  // 初始化移動與導航參數
  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  bot.pathfinder.setMovements(defaultMove);

  console.log(`📡 [系統] 正在等待主人 ${MY_MASTER_ID} 的私訊指令...`);
});

// ==================== 功能：監聽來自你的私訊 ====================
bot.on('messagestr', (message, position) => {
  const msg = message.trim();

  // 如果是 BOT 自己的名字出現在發言者位置，也直接忽略
  if (msg.startsWith('HIRO_NAGA')) {
    return;
  }
  
  // 檢查這條訊息是不是你發的私訊，且包含關鍵字 go
  // 這裡用更寬鬆但安全的條件：訊息內同時包含你的 ID、"go"、以及常見的私訊關鍵字
  if (
    msg.includes(MY_MASTER_ID) && 
    msg.toLowerCase().includes('go') &&
    (msg.includes('說') || msg.includes('私訊') || msg.includes('->') || msg.includes('密語') || msg.includes('w'))
  ) {
    if (isLoopRunning) {
      bot.chat(`/m ${MY_MASTER_ID} 我已經在挖土了，不要催我！`);
      return;
    }
    
    bot.chat(`/m ${MY_MASTER_ID} 收到指令！立即開始隨機傳送並挖泥土。`);
    console.log(`🚀 [指令] 偵測到主人私訊關鍵字，啟動主循環！ (原始訊息: ${msg})`);
    
    isLoopRunning = true;
    hasNotifiedNoShovel = false;
    startLoop(); // 觸發主循環
  }
});

// ==================== 功能：自動同意 TPA / TPAHERE ====================
bot.on('chat', (username, message) => {
  if (message.includes(MY_MASTER_ID) && (message.includes('請求') || message.includes('傳送') || message.includes('tpa'))) {
    console.log(`📥 [傳送] 偵測到來自 ${MY_MASTER_ID} 的傳送請求，自動輸入 /tpaccept`);
    bot.chat('/tpaccept');
  }
});

bot.on('messagestr', (message, position) => {
  if (message.includes(MY_MASTER_ID) && (message.includes('請求') || message.includes('傳送'))) {
    console.log(`📥 [傳送-系統] 偵測到傳送請求，自動輸入 /tpaccept`);
    bot.chat('/tpaccept');
  }
});

// ==================== 核心邏輯：修正後的自動挖泥土循環 ====================
async function startLoop() {
  try {
    // 1. 檢查身上是否還有鏟子 (檢查名稱包含 shovel 的物品)
    const hasShovel = bot.inventory.items().some(item => item.name.includes('shovel'));
    
    if (!hasShovel) {
      isLoopRunning = false; 
      
      // 💡 修正：如果還沒通知過，才發送私訊與 TPA
      if (!hasNotifiedNoShovel) {
        console.log('🛑 [工作] 沒有鏟子了，通知主人並申請 TPA 飛回去。');
        bot.chat(`/m ${MY_MASTER_ID} 我身上沒有鏟子了，停止工作！`);
        await sleep(1500); // 延遲 1.5 秒再發下一條指令，絕對防洗版
        
        // 自動要求傳送到你身邊
        bot.chat(`/tpa ${MY_MASTER_ID}`); 
        hasNotifiedNoShovel = true; // 標記為已通知
      }
      
      return; // 🛑 徹底跳出函數，結束這輪循環！
    }

    // 2. 執行隨機傳送到荒野
    console.log('➡️ [工作] 執行隨機傳送 /rpt...');
    bot.chat('/rpt');
    await sleep(7000); 

    // 3. 開始挖泥土，直到背包滿了
    console.log('⛏️ [工作] 開始尋找並採集泥土...');
    while (!isInventoryFull()) {
      // 在挖土的過程中，如果鏟子突然爆了，也要立刻中斷
      const currentShovel = bot.inventory.items().some(item => item.name.includes('shovel'));
      if (!currentShovel) {
        isLoopRunning = false;
        
        // 💡 修正：如果挖到一半爆了且還沒通知過，才發私訊
        if (!hasNotifiedNoShovel) {
          console.log('🛑 [工作] 挖到一半鏟子爆了！');
          bot.chat(`/m ${MY_MASTER_ID} 鏟子挖到爆了！工作中止。`);
          await sleep(1500);
          bot.chat(`/tpa ${MY_MASTER_ID}`);
          hasNotifiedNoShovel = true; // 標記為已通知
        }
        return;
      }

      const mcData = require('minecraft-data')(bot.version);
      const dirtBlock = bot.findBlock({
        matching: mcData.blocksByName.dirt.id,
        maxDistance: 16
      });

      if (dirtBlock) {
        try {
          await bot.collectBlock.collect(dirtBlock);
        } catch (err) {
          await sleep(500);
        }
      } else {
        await sleep(1000);
      }
    }

    // 4. 背包滿了，傳送回基地
    console.log('🎒 [工作] 背包滿了！準備回基地。');
    bot.chat(WARP_BASE_COMMAND);
    await sleep(7000); 

    // 5. 走向箱子並把泥土放進去
    console.log('📦 [工作] 正在走向基地箱子...');
    const mcData = require('minecraft-data')(bot.version);
    const targetChest = bot.blockAt(new (require('vec3'))(...CHEST_POSITION));
    
    if (targetChest && (targetChest.name === 'chest' || targetChest.name === 'trapped_chest')) {
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(CHEST_POSITION[0], CHEST_POSITION[1], CHEST_POSITION[2]));
        const chest = await bot.openChest(targetChest);
        
        const dirtItem = bot.inventory.items().find(item => item.name === 'dirt');
        if (dirtItem) {
          await chest.deposit(dirtItem.type, null, dirtItem.count);
          console.log(`✅ [工作] 已將 ${dirtItem.count} 個泥土存入基地箱子。`);
        }
        chest.close();
      } catch (err) {
        console.log('❌ [錯誤] 走向箱子或存放時失敗：', err);
      }
    } else {
      console.log('❌ [錯誤] 在指定座標找不到箱子，請確認 CHEST_POSITION 座標是否正確！');
    }

    // 💡 修正：既然成功走完一輪流程，代表身上狀態正常，重設通知狀態
    hasNotifiedNoShovel = false; 

    // 6. 重啟下一輪循環
    console.log('🔄 [工作] 準備進入下一輪循環...');
    await sleep(3000);
    startLoop();

  } catch (globalErr) {
    console.log('⚠️ [循環異常] 發生非預期錯誤...', globalErr);
    isLoopRunning = false;
  }
}

function isInventoryFull() {
  return bot.inventory.emptySlotCount() <= 2;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 基礎錯誤與斷線處理 ====================
bot.on('error', (err) => {
  if (err.message && err.message.includes('Read error')) return; 
  console.log('❌ [BOT錯誤]：', err);
});

bot.on('kicked', (reason) => console.log('🚪 [斷線] 被伺服器踢出：', reason));