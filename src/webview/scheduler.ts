/* eslint-disable curly */

type MaybePromise<T> = T | Promise<T>;

interface CoalescingTaskSchedulerOptions {
    debounceMs: number;
    run: () => MaybePromise<void>;
    onError?: (error: unknown) => void;
}

export class CoalescingTaskScheduler {
    declare private readonly debounceMs: number;
    declare private readonly run: () => MaybePromise<void>;
    declare private readonly onError: (error: unknown) => void;
    declare private timer: ReturnType<typeof setTimeout> | null;
    declare private pending: boolean;
    declare private running: boolean;

    constructor({ debounceMs, run, onError }: CoalescingTaskSchedulerOptions) {
        this.debounceMs = debounceMs;
        this.run = run;
        this.onError = onError || (() => {});
        this.timer = null;
        this.pending = false;
        this.running = false;
    }

    request(): void {
        this.pending = true;
        if (this.running) return;
        this.schedule();
    }

    private schedule(): void {
        if (this.timer) {
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
