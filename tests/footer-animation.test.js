import assert from "node:assert/strict";
import test from "node:test";

import {
  FOOTER_ANIMATION_CYCLE_MS,
  FooterAnimationController,
  runnerTranslatePixels,
  runnerTranslatePercent,
} from "../src/taskpane/footer-animation.js";

function createClock() {
  let time = 0;
  let nextId = 1;
  const frames = new Map();
  const timers = new Map();

  return {
    now: () => time,
    requestFrame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      frames.delete(id);
    },
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = time + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        time = timer.at;
        timer.callback();
      }
      time = target;
    },
    frameCount: () => frames.size,
  };
}

function createDeterministicRandom() {
  let state = 0x12345678;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function createController(clock, options = {}) {
  return new FooterAnimationController({
    now: clock.now,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: createDeterministicRandom(),
    ...options,
  });
}

test("页脚多人赛跑让唯一领跑者在五分钟首次到达", () => {
  const clock = createClock();
  const controller = createController(clock);

  controller.toggleManual();
  const initial = controller.snapshot();
  assert.equal(initial.phase, "main");
  assert.equal(initial.runners.length, 6);
  assert.equal(initial.runners.filter((runner) => runner.mainRaceTarget === 1).length, 1);
  assert.equal(clock.frameCount(), 1);

  clock.advance(FOOTER_ANIMATION_CYCLE_MS - 1);
  controller.syncClock();
  const justBeforeFinish = controller.snapshot();
  assert.equal(justBeforeFinish.phase, "main");
  assert.ok(justBeforeFinish.runners.every((runner) => runner.progress < 1));

  clock.advance(1);
  controller.syncClock();
  const leaderFinished = controller.snapshot();
  assert.equal(leaderFinished.phase, "catch-up");
  assert.equal(leaderFinished.completedCount, 0);
  assert.equal(leaderFinished.runners[leaderFinished.leaderId].progress, 1);
  assert.ok(
    leaderFinished.runners
      .filter((runner) => runner.id !== leaderFinished.leaderId)
      .every((runner) => runner.progress < 1),
  );
});

test("多人追赶结束后只计数一次并自动开始新的随机轮次", () => {
  const clock = createClock();
  const controller = createController(clock, {
    cycleMs: 300,
    catchUpMinMs: 6,
    catchUpMaxMs: 18,
    finishHoldMs: 2,
    flashMs: 20,
  });

  controller.toggleManual();
  const firstRaceProfile = controller.snapshot().runners.map((runner) => ({
    mainRaceTarget: runner.mainRaceTarget,
    catchUpMs: runner.catchUpMs,
  }));
  clock.advance(300);
  controller.syncClock();
  const catchUp = controller.snapshot();
  const maximumCatchUpMs = Math.max(...catchUp.runners.map((runner) => runner.catchUpMs));

  clock.advance(maximumCatchUpMs - 1);
  controller.syncClock();
  assert.equal(controller.snapshot().completedCount, 0);

  clock.advance(1);
  controller.syncClock();
  const finished = controller.snapshot();
  assert.equal(finished.phase, "finished");
  assert.equal(finished.completedCount, 1);
  assert.equal(finished.flashText, "+1");
  assert.ok(finished.runners.every((runner) => runner.progress === 1));

  clock.advance(2);
  controller.syncClock();
  const nextRace = controller.snapshot();
  assert.equal(nextRace.phase, "main");
  assert.equal(nextRace.completedCount, 1);
  assert.ok(nextRace.runners.every((runner) => runner.progress === 0));
  assert.notDeepEqual(
    nextRace.runners.map((runner) => ({ mainRaceTarget: runner.mainRaceTarget, catchUpMs: runner.catchUpMs })),
    firstRaceProfile,
  );
  assert.equal(clock.frameCount(), 1);
});

test("暂停和继续保留六名人物的位置并且不重复创建帧循环", () => {
  const clock = createClock();
  const controller = createController(clock, { cycleMs: 1_000 });

  controller.toggleManual();
  clock.advance(375);
  assert.equal(controller.pause(), true);
  const pausedProgress = controller.snapshot().runners.map((runner) => runner.progress);
  assert.equal(clock.frameCount(), 0);

  clock.advance(50_000);
  assert.deepEqual(controller.snapshot().runners.map((runner) => runner.progress), pausedProgress);

  assert.equal(controller.toggleManual(), true);
  assert.deepEqual(controller.snapshot().runners.map((runner) => runner.progress), pausedProgress);
  assert.equal(clock.frameCount(), 1);

  controller.lockForConversation();
  assert.equal(clock.frameCount(), 1);
  assert.equal(controller.toggleManual(), false);
  controller.unlockConversation();
  assert.equal(controller.pause(), true);
  assert.deepEqual(controller.snapshot().runners.map((runner) => runner.progress), pausedProgress);
});

test("帧回调推进赛跑但始终只保留一个待执行帧", () => {
  const clock = createClock();
  const controller = createController(clock, { cycleMs: 1_000 });

  controller.toggleManual();
  assert.equal(clock.frameCount(), 1);
  controller.syncClock();
  assert.equal(clock.frameCount(), 1);
  controller.lockForConversation();
  assert.equal(clock.frameCount(), 1);
  controller.unlockConversation();
  assert.equal(clock.frameCount(), 1);
});

test("对话开始强制播放并在结束后恢复手动控制", () => {
  const clock = createClock();
  const controller = createController(clock);

  controller.lockForConversation();
  assert.deepEqual(
    {
      playing: controller.snapshot().playing,
      locked: controller.snapshot().locked,
      mode: controller.snapshot().mode,
    },
    { playing: true, locked: true, mode: "conversation" },
  );
  assert.equal(controller.toggleManual(), false);

  controller.unlockConversation();
  assert.deepEqual(
    {
      playing: controller.snapshot().playing,
      locked: controller.snapshot().locked,
      mode: controller.snapshot().mode,
    },
    { playing: true, locked: false, mode: "manual" },
  );
  assert.equal(controller.toggleManual(), true);
  assert.equal(controller.snapshot().playing, false);
});

test("手动播放时对话锁定会立即发布不可暂停状态", () => {
  const clock = createClock();
  const snapshots = [];
  const controller = createController(clock, { onChange: (state) => snapshots.push(state) });

  controller.toggleManual();
  snapshots.length = 0;
  controller.lockForConversation();

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].locked, true);
  assert.equal(snapshots[0].mode, "conversation");
});

test("人物横向位置受单一进度限制", () => {
  assert.equal(runnerTranslatePercent(-1, 0), 0.02);
  assert.equal(runnerTranslatePercent(2, 5), 1);
  assert.equal(runnerTranslatePercent(0.5, 2), 0.524);
  assert.ok(runnerTranslatePercent(0.001, 0) > runnerTranslatePercent(0, 0));
  assert.ok(runnerTranslatePercent(0, 1) > runnerTranslatePercent(0, 0));
});

test("人物横向位置按跑道实际像素宽度计算", () => {
  assert.equal(Number(runnerTranslatePixels(-1, 0, 320, 20).toFixed(3)), 6);
  assert.equal(Number(runnerTranslatePixels(0.5, 2, 320, 20).toFixed(3)), 157.2);
  assert.equal(Number(runnerTranslatePixels(2, 5, 320, 20).toFixed(3)), 300);
  assert.equal(Number(runnerTranslatePixels(0.5, 2, 0, 20).toFixed(3)), 0);
});
