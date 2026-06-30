const test = require('node:test');
const assert = require('node:assert/strict');
const fsm = require('./fsm');
const mining = require('./mining');

test('shouldRtpForMiningStuck triggers after the idle threshold', () => {
    fsm.state.isLoopRunning = true;
    fsm.state.isInWild = true;
    fsm.state.currentState = 'Mine';
    fsm.state.miningLastPosition = { x: 10, y: 64, z: 20 };
    fsm.state.miningIdleSince = Date.now() - 30000;

    const bot = {
        entity: {
            position: { x: 10, y: 64, z: 20 }
        }
    };

    assert.equal(fsm.shouldRtpForMiningStuck(bot), true);
});

test('runEscape immediately re-enters mining after teleport', async () => {
    const originalRunMineStep = mining.runMineStep;
    let called = false;
    mining.runMineStep = async () => {
        called = true;
    };

    try {
        let gotoCalled = false;
        const bot = {
            pathfinder: {
                stop() { },
                setGoal() { },
                goto() {
                    gotoCalled = true;
                }
            },
            chat() { },
            clearControlStates() { },
            async waitForChunksToLoad() { },
            entity: { position: { x: 0, y: 64, z: 0 } },
            inventory: { items: () => [] },
            health: 20,
            food: 20
        };

        fsm.state.mcData = {};
        await fsm.runEscape(bot);

        assert.equal(called, true);
        assert.equal(gotoCalled, false);
        assert.equal(fsm.state.currentState, 'Mine');
    } finally {
        mining.runMineStep = originalRunMineStep;
    }
});

test('mining progress resets the idle timer', () => {
    fsm.state.isLoopRunning = true;
    fsm.state.isInWild = true;
    fsm.state.currentState = 'Mine';
    fsm.state.miningLastPosition = { x: 10, y: 64, z: 20 };
    fsm.state.miningIdleSince = Date.now() - 1000;
    fsm.state.miningIdleWarningShown = true;

    const bot = {
        entity: {
            position: { x: 10, y: 64, z: 20 }
        }
    };

    fsm.markMiningProgress(bot);

    assert.equal(fsm.state.miningLastPosition.x, 10);
    assert.equal(fsm.state.miningLastPosition.y, 64);
    assert.equal(fsm.state.miningLastPosition.z, 20);
    assert.ok(Date.now() - fsm.state.miningIdleSince < 1000);
    assert.equal(fsm.state.miningIdleWarningShown, false);
});

test('runMineStep clears stale collectBlock state after timeout', async () => {
    const targets = {
        clear() { },
        appendTargets() { },
        appendTarget() { },
        removeTarget() { }
    };

    const bot = {
        entity: { position: { x: 0, y: 64, z: 0 } },
        targetBlock: { position: { x: 1, y: 64, z: 1 } },
        isDigging: true,
        heldItem: null,
        inventory: { items: () => [] },
        pathfinder: { stop() { } },
        stopDigging() { },
        findBlocks() {
            return [{ x: 1, y: 64, z: 1 }];
        },
        blockAt() {
            return { position: { x: 1, y: 64, z: 1 } };
        },
        collectBlock: {
            customEvents: { removeAllListeners() { } },
            targets,
            currentTarget: { position: { x: 1, y: 64, z: 1 } },
            collecting: true,
            collect() {
                return new Promise(() => { });
            },
            stop() { }
        }
    };

    const runtime = {
        mcData: { blocksByName: { dirt: { id: 1 } } },
        loopConfig: { ...mining.MINING_CONFIG, collectTimeoutMs: 20 },
        state: {
            collectErrorCount: 0,
            markMiningProgress() { },
            setIsInWild() { },
            resetCollectErrorCount() {
                this.collectErrorCount = 0;
            },
            incrementCollectErrorCount() {
                this.collectErrorCount += 1;
                return this.collectErrorCount;
            },
            setTargetCount() { }
        }
    };

    await mining.runMineStep(bot, runtime);

    assert.equal(bot.targetBlock, null);
    assert.equal(Array.isArray(bot.collectBlock.targets), false);
    assert.equal(typeof bot.collectBlock.targets.clear, 'function');
    assert.equal(bot.collectBlock.currentTarget, null);
    assert.equal(bot.collectBlock.collecting, false);
    assert.equal(bot.isDigging, false);
});
