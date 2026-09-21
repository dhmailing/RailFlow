// A single-slot timer controller: at most one pending callback exists at any
// moment. Deliberately duplicated from lib/demo/timer.ts rather than
// imported -- lib/automation-demo/** must stay fully independent (see
// types.ts's header). Scheduling a new callback (or restarting) always
// clears whatever was pending first, so a stale callback can never fire
// later and push the state machine through two steps at once. Only uses
// global setTimeout/clearTimeout, so it runs identically in the browser,
// under Playwright's page.clock virtualization, and under Node (this
// module's own offline tests).
export type AutomationDemoTimerController = {
  schedule: (callback: () => void, delayMs: number) => void;
  clear: () => void;
  isScheduled: () => boolean;
};

export function createAutomationDemoTimerController(): AutomationDemoTimerController {
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
