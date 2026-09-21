// A single-slot timer controller: at most one pending callback exists at
// any moment. Scheduling a new callback (or restarting) always clears
// whatever was pending first, so a stale callback from a previous demo
// step, a previous job, or a cancelled/restarted journey can never fire
// later and push the state machine through two steps at once (§6, §14 --
// "중복 timer로 상태가 두 단계 이상 건너뛰지 않도록 방지").
//
// This is the only thing in lib/demo/** that touches a real timer; the FSM
// (state-machine.ts) and scenario math (scenarios.ts) stay pure and
// timer-free so they can be unit-tested without fake timers. This module
// itself only uses global setTimeout/clearTimeout, so it runs identically
// in the browser and under Node (scripts/verify-demo-showcase.cjs).
export type DemoTimerController = {
  schedule: (callback: () => void, delayMs: number) => void;
  clear: () => void;
  isScheduled: () => boolean;
};

export function createDemoTimerController(): DemoTimerController {
  let handle: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  }

  function schedule(callback: () => void, delayMs: number): void {
    clear();
    handle = setTimeout(() => {
      handle = null;
      callback();
    }, delayMs);
  }

  function isScheduled(): boolean {
    return handle !== null;
  }

  return { schedule, clear, isScheduled };
}
