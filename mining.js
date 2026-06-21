const { goals } = require('mineflayer-pathfinder');
const { MY_MASTER_ID, WARP_BASE_COMMAND, CHEST_POSITION } = require('./config');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isInventoryFull = (bot) => bot.inventory.emptySlotCount() <= 2;

// 狀態管理物件
const state = {
  isLoopRunning: false,
  hasNotifiedNoShovel: false,
  isEscaping: false, 
  isListenerBound: false 
};

// 🛠️ 核心功能：根據方塊名稱，自動裝備正確工具
async function equipToolForBlock(bot, blockName) {
  let toolKeyword = '';
  
  if (blockName.includes('dirt') || blockName.includes('grass') || blockName.includes('sand')) {
    toolKeyword = 'shovel';    // 泥土、草地、沙子用鏟子
  } else if (
    blockName.includes('stone') || 
    blockName.includes('cobblestone') || 
    blockName.includes('andesite') || 
    blockName.includes('diorite') || 
    blockName.includes('granite')
  ) {
    toolKeyword = 'pickaxe';   // 任何石頭類用十字鎬
  }

  if (!toolKeyword) return;

  // 如果手上已經拿著對應工具，直接跳過不重複切換
  const heldItem = bot.heldItem;
  if (heldItem && heldItem.name.includes(toolKeyword)) return;

  // 從背包尋找工具並裝備
  const tool = bot.inventory.items().find(item => item.name.includes(toolKeyword));
  if (tool) {
    try {
      await bot.equip(tool, 'hand');
      console.log(`🔧 [工具] 偵測到挖掘方塊 ${blockName}，自動切換裝備：${tool.name}`);
    } catch (err) {
      console.log(`⚠️ [工具] 切換工具失敗: ${err.message}`);
    }
  }
}

async function startLoop(bot) {
  // 🛠️ 首次執行時，同時綁定「受傷監聽」與「自動切工具監聽」
  if (!state.isListenerBound) {
    setupHealthListener(bot);
    setupDiggingListener(bot); // 綁定挖掘監聽
    state.isListenerBound = true;
  }

  try {
    if (!state.isLoopRunning) return;

    // 1. 檢查身上是否還有工作用的鏟子
    const hasShovel = bot.inventory.items().some(item => item.name.includes('shovel'));
    if (!hasShovel) {
      state.isLoopRunning = false; 
      if (!state.hasNotifiedNoShovel) {
        console.log('🛑 [工作] 沒有鏟子了，通知主人並申請 TPA 飛回去。');
        bot.chat(`/m ${MY_MASTER_ID} 我身上沒有鏟子了，停止工作！`);
        await sleep(1500);
        bot.chat(`/tpa ${MY_MASTER_ID}`); 
        state.hasNotifiedNoShovel = true;
      }
      return;
    }

    // 2. 執行隨機傳送到荒野
    console.log('➡️ [工作] 執行隨機傳送 /rtp...');
    bot.chat('/rtp');
    await sleep(7000); 

   // 3. 開始挖泥土，直到背包滿了 (優化版)
    console.log('⛏️ [工作] 開始尋找並採集泥土...');
    const mcData = require('minecraft-data')(bot.version);

    while (!isInventoryFull(bot)) {
      if (state.isEscaping) { await sleep(1000); continue; }
      if (!state.isLoopRunning) return;

      // 檢查鏟子
      const currentShovel = bot.inventory.items().some(item => item.name.includes('shovel'));
      if (!currentShovel) {
        state.isLoopRunning = false;
        if (!state.hasNotifiedNoShovel) {
          bot.chat(`/m ${MY_MASTER_ID} 鏟子挖到爆了！工作中止。`);
          await sleep(1500);
          bot.chat(`/tpa ${MY_MASTER_ID}`);
          state.hasNotifiedNoShovel = true;
        }
        return;
      }

      // 💡 加速改動：一口氣抓周圍 8 個泥土方塊，而不是只抓 1 個
      const dirtBlocks = bot.findBlocks({
        matching: mcData.blocksByName.dirt.id,
        maxDistance: 10, // 縮短半徑到 10 格，離太遠的不要去，減少走遠路的時間
        count: 8         // 一次打包 8 個目標
      });

      if (dirtBlocks.length > 0) {
        // 將座標陣列轉換成實際的方塊物件
        const targets = dirtBlocks.map(pos => bot.blockAt(pos)).filter(Boolean);
        
        try {
          // 💡 核心加速：使用 collectBlock 的多方塊採集功能
          // 這樣套件內部會優化路線，一口氣把這 8 個方塊連著挖完，中間不頓挫！
          await bot.collectBlock.collect(targets, {
            ignoreFrame: true, // 忽略副手等無關檢查，加快速度
            count: targets.length,
            chestRadius: 3, // 接近方塊到半徑 3 格內就停下
            itemRadius: 3,  // 接近掉落物到半徑 3 格內就吸取
          });
        } catch (err) {
          // 發生小錯誤（例如方塊被別人挖走）稍微等一下就好
          await sleep(100); 
        }
      } else {
        // 如果身邊真的沒泥土了，BOT 會原地看一看，等 500 毫秒
        await sleep(500); 
      }
    }

    if (state.isEscaping) { await sleep(1000); return startLoop(bot); }

    // 4. 背包滿了，傳送回基地
    console.log('🎒 [工作] 背包滿了！準備回基地。');
    bot.chat(WARP_BASE_COMMAND);
    await sleep(7000); 

    // 5. 走向箱子並把泥土放進去
    console.log('📦 [工作] 正在走向基地箱子...');
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

    state.hasNotifiedNoShovel = false; 

    // 6. 重啟下一輪循環
    console.log('🔄 [工作] 準備進入下一輪循環...');
    await sleep(3000);
    startLoop(bot);

  } catch (globalErr) {
    console.log('⚠️ [循環異常] 發生非預期錯誤...', globalErr);
    state.isLoopRunning = false;
  }
}

// 🛠️ 新增：監聽 BOT 的挖掘動作
function setupDiggingListener(bot) {
  // 當 BOT 因為任何原因（包含主動採集或尋路開路）開始挖掘方塊時觸發
  bot.on('diggingStart', async (block) => {
    if (!state.isLoopRunning || state.isEscaping) return;
    
    if (block && block.name) {
      // 只要手一伸出去準備挖，瞬間攔截並換上對應工具
      await equipToolForBlock(bot, block.name);
    }
  });
}

function setupHealthListener(bot) {
  let lastHealth = 20;

  bot.on('health', async () => {
    if (!state.isLoopRunning) return;

    // --- 1. 自動吃牛排邏輯 ---
    // 麥塊滿肚是 20，掉到 15 以下（空 2.5 格肉) 就該補了，且確保沒在逃跑或重複吃
    if (bot.food <= 15 && !state.isEating && !state.isEscaping) {
      // 從背包找牛排 (cooked_beef)
      const steak = bot.inventory.items().find(item => item.name === 'cooked_beef');
      
      if (steak) {
        console.log(`🍖 [補給] 飢餓度過低 (${bot.food}/20)，開始吃牛排...`);
        state.isEating = true;
        
        try {
          bot.pathfinder.stop(); // 停止走路，專心吃飯
          await bot.equip(steak, 'hand'); // 手拿牛排
          await bot.consume(); // 啃牛排（內建會等待吃完的動畫時間）
          console.log(`✅ [補給] 牛排吃飽了！目前飢餓度: ${bot.food}/20`);
        } catch (err) {
          console.log(`⚠️ [補給] 吃牛排失敗: ${err.message}`);
        } finally {
          state.isEating = false; // 恢復常態
        }
      } else {
        // 如果背包沒牛排了，每隔一陣子在控制台提醒你
        console.log('⚠️ [警告] BOT 肚子餓了，但背包裡找不到「cooked_beef」（牛排）！');
      }
    }

    // --- 2. 受傷逃跑邏輯 ---
    const currentHealth = bot.health;
    if (currentHealth < lastHealth) {
      if (state.isEscaping || state.isEating) { 
        lastHealth = currentHealth; 
        return; 
      }
      console.log(`🚨 [安全防護] BOT 受傷了！立刻執行緊急 /rtp 逃跑！`);
      state.isEscaping = true;
      try {
        bot.pathfinder.stop();
        bot.chat('/rtp');
        await sleep(7000);
      } catch (err) {
        console.log('⚠️ [安全防護] 逃跑異常:', err);
      } finally {
        state.isEscaping = false;
      }
    }
    lastHealth = currentHealth;
  });
}

module.exports = { state, startLoop };