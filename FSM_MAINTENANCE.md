# Minecraft Bot FSM 維護指南

## 1) 現在架構是什麼

目前專案主流程已改為單一有限狀態機（FSM），入口在 fsm.js。

核心檔案：
- fsm.js：狀態定義、狀態判斷、tick 迴圈、狀態執行函式（唯一入口）
- mining.js：採礦模組（Mine 狀態的行為實作）
- index.js：指令入口（go/storage/stop）
- storage.js：存倉任務實作
- supplies.js：補給任務實作

執行方式：
1. index.js 收到指令後，呼叫 fsm.js 的 API。
2. fsm.js 每 500ms tick 一次。
3. 每次 tick 先決策下一個狀態，再執行對應行為。

---

## 2) 狀態與優先序

目前狀態：
- Idle
- Escape
- Eat
- ManualStorage
- Supply
- InventoryStorage
- EnsureWild
- Mine

決策優先序（由高到低）：
1. Escape（受傷或遇敵）
2. Eat（飢餓且有食物）
3. ManualStorage（主人手動要求 storage）
4. Supply（物資不足）
5. InventoryStorage（背包滿）
6. EnsureWild（不在野外）
7. Mine（採集）

這代表同一個 tick 只會選一個狀態執行，避免行為互搶。

---

## 3) 狀態資料（state）

由 fsm.js 的 state 集中管理：
- isLoopRunning：主循環是否啟動
- isTicking：本輪 tick 是否進行中
- pendingStorage：是否有手動存倉請求
- isInWild：是否在野外作業區
- collectErrorCount：連續採集異常計數
- damageDetected：是否偵測到受傷
- enemyDetected：是否偵測到附近敵人
- currentState：目前狀態

原則：
- 狀態欄位保持少而清楚。
- 不要把一次性區域變數塞進全域 state。

---

## 4) 維護規則（最重要）

Do：
- 先改 decideNextState，再改對應 runXxx。
- 一個 runXxx 只做一件主要責任。
- 共用參數集中在 LOOP_CONFIG。
- 保持 go/storage/stop 對外 API 穩定。

Don't：
- 不要在多個地方各自判斷優先序。
- 不要讓 runXxx 互相直接呼叫形成隱性流程。
- 不要把聊天指令字串硬編碼到多個檔案。

---

## 5) 新增一個狀態的標準流程

以新增 FoodCollect 為例：
1. 在 FSM_STATE 增加 FoodCollect。
2. 新增觸發條件（例如 needFoodCollect）。
3. 在 decideNextState 放入正確優先序位置。
4. 新增 runFoodCollect(bot)。
5. 在 switch 增加 case FSM_STATE.FoodCollect。
6. 驗證是否與現有狀態衝突（尤其 Escape 與 Supply）。

---

## 6) 指令語意

- go：啟動 FSM 循環
- storage：設定 pendingStorage，交由 FSM 在優先序中處理
- stop：停止 FSM 循環並清理 tick timer

原則：
- index.js 只做指令解析與 API 呼叫，不直接執行業務流程。

---

## 7) 最低驗證清單

每次修改後至少做：
1. node --check fsm.js
2. node --check index.js
3. node --check mining.js
4. VS Code 問題面板確認無新增錯誤
5. 實測指令 go / storage / stop

---

## 8) 何時要重構

出現以下任一情況就該重構：
- decideNextState 變得太長且難讀
- 多個 runXxx 共用大量重複邏輯
- 新增一個行為需要改超過 3 個既有狀態

建議方向：
- 抽出 fsm/decision.js（純決策）
- 抽出 fsm/actions.js（狀態執行）
- fsm.js 保留組裝與生命週期管理
- mining.js 維持純採礦模組
