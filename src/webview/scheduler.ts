// @ts-nocheck
/* eslint-disable curly */

export class CoalescingTaskScheduler {
        constructor({ debounceMs, run, onError }) {
            this.debounceMs = debounceMs;
            this.run = run;
            this.onError = onError || (() => {});
            this.timer = null;
            this.pending = false;
            this.running = false;
        }

        request() {
            this.pending = true;
            if (this.running) return;
            this.schedule();
        }

        schedule() {
            if (this.timer) {
                clearTimeout(this.timer);
            }
            this.timer = setTimeout(() => this.flush(), this.debounceMs);
        }

        async flush() {
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



