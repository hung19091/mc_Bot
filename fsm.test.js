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
    let called = false;
    mining.runMineStep = async () => {
        called = true;
    };

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
});
