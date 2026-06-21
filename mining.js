const { goals } = require('mineflayer-pathfinder');
const { MY_MASTER_ID, WARP_BASE_COMMAND, CHEST_POSITION } = require('./config');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isInventoryFull = (bot) => bot.inventory.emptySlotCount() <= 2;

// 狀態管理物件
const state = {
  isLoopRunning: false,
  hasNotifiedNoShovel: false
};

async function startLoop(bot) {
  try {
    // 1. 檢查身上是否還有鏟子
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

    // 3. 開始挖泥土，直到背包滿了
    console.log('⛏️ [工作] 開始尋找並採集泥土...');
    while (!isInventoryFull(bot)) {
      const currentShovel = bot.inventory.items().some(item => item.name.includes('shovel'));
      if (!currentShovel) {
        state.isLoopRunning = false;
        if (!state.hasNotifiedNoShovel) {
          console.log('🛑 [工作] 挖到一半鏟子爆了！');
          bot.chat(`/m ${MY_MASTER_ID} 鏟子挖到爆了！工作中止。`);
          await sleep(1500);
          bot.chat(`/tpa ${MY_MASTER_ID}`);
          state.hasNotifiedNoShovel = true;
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

    // 5. 走向箱子並把泥土放進去（舊有的固定座標邏輯保留）
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

module.exports = { state, startLoop };