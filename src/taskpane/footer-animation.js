export const FOOTER_ANIMATION_CYCLE_MS = 5 * 60 * 1000;
export const FOOTER_ANIMATION_CATCH_UP_MIN_MS = 600;
export const FOOTER_ANIMATION_CATCH_UP_MAX_MS = 1_800;
export const FOOTER_ANIMATION_FINISH_HOLD_MS = 220;
export const FOOTER_ANIMATION_FLASH_MS = 1_400;

const RUNNER_COUNT = 6;
const RUNNER_START_OFFSET = 0.02;
const RUNNER_START_STAGGER = 0.014;
const MAIN_RACE_FOLLOWER_MIN_PROGRESS = 0.48;
const MAIN_RACE_FOLLOWER_MAX_PROGRESS = 0.88;

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function defaultRequestFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(defaultNow()), 16);
}

function defaultCancelFrame(frame) {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(frame);
    return;
  }
  globalThis.clearTimeout(frame);
}

function defaultSetTimer(callback, delay) {
  return globalThis.setTimeout(callback, delay);
}

function defaultClearTimer(timer) {
  globalThis.clearTimeout(timer);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function toRandomUnit(random) {
  const value = Number(random());
  return Number.isFinite(value) ? clamp(value, 0, 0.999999) : 0.5;
}

function weightedProgress(weights, progress) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;

  const segmentProgress = progress * weights.length;
  const completedSegments = Math.floor(segmentProgress);
  const partialSegment = segmentProgress - completedSegments;
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const completedWeight = weights.slice(0, completedSegments).reduce((sum, weight) => sum + weight, 0);
  const currentWeight = weights[Math.min(completedSegments, weights.length - 1)] ?? 0;
  return clamp((completedWeight + currentWeight * partialSegment) / totalWeight, 0, 1);
}

function createRaceProfile(random, cycleMs, catchUpMinMs, catchUpMaxMs) {
  const leaderId = Math.floor(toRandomUnit(random) * RUNNER_COUNT);
  const runners = Array.from({ length: RUNNER_COUNT }, (_, id) => {
    const weights = Array.from({ length: 4 }, () => 0.55 + toRandomUnit(random) * 0.9);
    const mainRaceTarget = id === leaderId
      ? 1
      : MAIN_RACE_FOLLOWER_MIN_PROGRESS
        + toRandomUnit(random) * (MAIN_RACE_FOLLOWER_MAX_PROGRESS - MAIN_RACE_FOLLOWER_MIN_PROGRESS);
    const catchUpMs = id === leaderId
      ? 0
      : Math.round(
          catchUpMinMs + toRandomUnit(random) * (catchUpMaxMs - catchUpMinMs),
        );

    return {
      id,
      weights,
      mainRaceTarget,
      catchUpMs,
      progress: 0,
    };
  });

  return { leaderId, runners, cycleMs };
}

/**
 * Owns the footer race clock. The renderer receives positions from this one
 * source of time, so pause and resume never have to reconstruct CSS timelines.
 */
export class FooterAnimationController {
  constructor({
    now = defaultNow,
    requestFrame = defaultRequestFrame,
    cancelFrame = defaultCancelFrame,
    setTimer = defaultSetTimer,
    clearTimer = defaultClearTimer,
    random = Math.random,
    cycleMs = FOOTER_ANIMATION_CYCLE_MS,
    catchUpMinMs = FOOTER_ANIMATION_CATCH_UP_MIN_MS,
    catchUpMaxMs = FOOTER_ANIMATION_CATCH_UP_MAX_MS,
    finishHoldMs = FOOTER_ANIMATION_FINISH_HOLD_MS,
    flashMs = FOOTER_ANIMATION_FLASH_MS,
    onChange = () => {},
  } = {}) {
    if (!Number.isFinite(cycleMs) || cycleMs <= 0) {
      throw new TypeError("Footer animation cycle must be positive.");
    }
    if (!Number.isFinite(catchUpMinMs) || !Number.isFinite(catchUpMaxMs) || catchUpMinMs <= 0 || catchUpMaxMs < catchUpMinMs) {
      throw new TypeError("Footer animation catch-up range is invalid.");
    }

    this.now = now;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.random = random;
    this.cycleMs = cycleMs;
    this.catchUpMinMs = catchUpMinMs;
    this.catchUpMaxMs = catchUpMaxMs;
    this.finishHoldMs = finishHoldMs;
    this.flashMs = flashMs;
    this.onChange = onChange;
    this.started = false;
    this.playing = false;
    this.locked = false;
    this.mode = "idle";
    this.phase = "ready";
    this.elapsedMs = 0;
    this.completedCount = 0;
    this.flashText = "";
    this.startedAt = null;
    this.frame = null;
    this.flashTimer = null;
    this.race = createRaceProfile(this.random, this.cycleMs, this.catchUpMinMs, this.catchUpMaxMs);
  }

  snapshot() {
    return {
      started: this.started,
      playing: this.playing,
      locked: this.locked,
      mode: this.mode,
      phase: this.phase,
      elapsedMs: this.elapsedMs,
      completedCount: this.completedCount,
      flashText: this.flashText,
      leaderId: this.race.leaderId,
      runners: this.race.runners.map(({ id, progress, mainRaceTarget, catchUpMs }) => ({
        id,
        progress,
        mainRaceTarget,
        catchUpMs,
      })),
    };
  }

  emit() {
    this.onChange(this.snapshot());
  }

  clearFrame() {
    if (this.frame === null) return;
    this.cancelFrame(this.frame);
    this.frame = null;
  }

  clearFlashTimer() {
    if (this.flashTimer === null) return;
    this.clearTimer(this.flashTimer);
    this.flashTimer = null;
  }

  showCompletion() {
    this.flashText = "+1";
    this.clearFlashTimer();
    this.flashTimer = this.setTimer(() => {
      this.flashTimer = null;
      this.flashText = "";
      this.emit();
    }, this.flashMs);
  }

  scheduleFrame() {
    if (!this.playing || this.frame !== null) return;
    this.frame = this.requestFrame((timestamp) => {
      this.frame = null;
      this.syncClock(timestamp);
      this.emit();
      this.scheduleFrame();
    });
  }

  updateMainRace(elapsedMs) {
    const mainRaceProgress = clamp(elapsedMs / this.cycleMs, 0, 1);
    for (const runner of this.race.runners) {
      runner.progress = weightedProgress(runner.weights, mainRaceProgress) * runner.mainRaceTarget;
    }
  }

  updateCatchUp(elapsedMs) {
    for (const runner of this.race.runners) {
      if (runner.id === this.race.leaderId) {
        runner.progress = 1;
        continue;
      }

      const mainProgress = runner.mainRaceTarget;
      const catchUpProgress = clamp(elapsedMs / runner.catchUpMs, 0, 1);
      runner.progress = mainProgress + (1 - mainProgress) * catchUpProgress;
    }
  }

  startFinishHold() {
    if (this.phase === "finished") return;
    this.phase = "finished";
    this.elapsedMs = 0;
    this.completedCount += 1;
    this.showCompletion();
  }

  startNextRace() {
    this.race = createRaceProfile(this.random, this.cycleMs, this.catchUpMinMs, this.catchUpMaxMs);
    this.elapsedMs = 0;
    this.phase = "main";
  }

  advanceRace(elapsedMs) {
    let remainingMs = elapsedMs;
    let transitions = 0;

    while (remainingMs > 0 && transitions < 64) {
      transitions += 1;
      if (this.phase === "main") {
        const remainingMainMs = this.cycleMs - this.elapsedMs;
        const consumedMs = Math.min(remainingMs, remainingMainMs);
        this.elapsedMs += consumedMs;
        remainingMs -= consumedMs;
        this.updateMainRace(this.elapsedMs);
        if (this.elapsedMs < this.cycleMs) break;
        this.phase = "catch-up";
        this.elapsedMs = 0;
        continue;
      }

      if (this.phase === "catch-up") {
        const maximumCatchUpMs = Math.max(...this.race.runners.map((runner) => runner.catchUpMs));
        const remainingCatchUpMs = maximumCatchUpMs - this.elapsedMs;
        const consumedMs = Math.min(remainingMs, remainingCatchUpMs);
        this.elapsedMs += consumedMs;
        remainingMs -= consumedMs;
        this.updateCatchUp(this.elapsedMs);
        if (this.elapsedMs < maximumCatchUpMs) break;
        this.startFinishHold();
        continue;
      }

      if (this.phase === "finished") {
        const remainingHoldMs = this.finishHoldMs - this.elapsedMs;
        const consumedMs = Math.min(remainingMs, remainingHoldMs);
        this.elapsedMs += consumedMs;
        remainingMs -= consumedMs;
        if (this.elapsedMs < this.finishHoldMs) break;
        this.startNextRace();
        continue;
      }

      break;
    }
  }

  syncClock(timestamp = this.now()) {
    if (!this.playing || this.startedAt === null) return;

    const elapsedSinceStart = Math.max(0, timestamp - this.startedAt);
    this.startedAt = timestamp;
    this.advanceRace(elapsedSinceStart);
  }

  pause() {
    if (!this.playing) return false;
    this.syncClock();
    this.playing = false;
    this.mode = "manual";
    this.startedAt = null;
    this.clearFrame();
    this.emit();
    return true;
  }

  play(mode = "manual") {
    const wasPlaying = this.playing;
    this.started = true;
    this.playing = true;
    this.mode = mode;
    if (this.phase === "ready") this.phase = "main";
    if (!wasPlaying) this.startedAt = this.now();
    if (!wasPlaying) this.emit();
    this.scheduleFrame();
  }

  toggleManual() {
    if (this.locked) return false;
    if (this.playing) return this.pause();
    this.play("manual");
    return true;
  }

  lockForConversation() {
    const wasPlaying = this.playing;
    if (wasPlaying) this.syncClock();
    this.locked = true;
    this.play("conversation");
    if (wasPlaying) this.emit();
  }

  unlockConversation() {
    if (!this.locked) return;
    if (this.playing) this.syncClock();
    this.locked = false;
    this.mode = this.playing ? "manual" : "idle";
    this.emit();
    this.scheduleFrame();
  }

  destroy() {
    this.clearFrame();
    this.clearFlashTimer();
  }
}

export function runnerTranslatePercent(progress, runnerId) {
  const startOffset = RUNNER_START_OFFSET + runnerId * RUNNER_START_STAGGER;
  const normalizedProgress = clamp(progress, 0, 1);
  return startOffset + (1 - startOffset) * normalizedProgress;
}

export function runnerTranslatePixels(progress, runnerId, stageWidth, runnerWidth) {
  const safeStageWidth = Number.isFinite(stageWidth) ? Math.max(0, stageWidth) : 0;
  const safeRunnerWidth = Number.isFinite(runnerWidth) ? Math.max(0, runnerWidth) : 0;
  const trackWidth = Math.max(0, safeStageWidth - safeRunnerWidth);
  return trackWidth * runnerTranslatePercent(progress, runnerId);
}
