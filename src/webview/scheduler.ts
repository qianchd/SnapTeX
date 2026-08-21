/* eslint-disable curly */

type MaybePromise<T> = T | Promise<T>;

interface CoalescingTaskSchedulerOptions {
    debounceMs: number;
    run: () => MaybePromise<void>;
    onError?: (error: unknown) => void;
}

/**
 * Debounces task requests while guaranteeing that changes requested during an
 * active run execute once more after the current run finishes.
 */
export class CoalescingTaskScheduler {
    declare private readonly debounceMs: number;
    declare private readonly run: () => MaybePromise<void>;
    declare private readonly onError: (error: unknown) => void;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending = false;
    private running = false;

    constructor({ debounceMs, run, onError }: CoalescingTaskSchedulerOptions) {
        this.debounceMs = debounceMs;
        this.run = run;
        this.onError = onError || (() => {});
    }

    request(): void {
        this.pending = true;
        if (this.running) return;
        this.schedule();
    }

    private schedule(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => this.flush(), this.debounceMs);
    }

    private async flush(): Promise<void> {
        this.timer = null;
        if (!this.pending || this.running) return;

        this.pending = false;
        this.running = true;
        try {
            await this.run();
        } catch (error) {
            this.onError(error);
        } finally {
            this.running = false;
            if (this.pending) {
                this.schedule();
            }
        }
    }
}
