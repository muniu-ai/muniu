// SPDX-License-Identifier: Apache-2.0

/**
 * Serializes worker control-plane writes without ever leaving a rejected
 * Promise unobserved. Node treats an unhandled rejection as process-fatal;
 * that would bypass the worker's claim release and sandbox Pod cleanup.
 */
export class SerializedWorkerPostQueue {
  #tail: Promise<void> = Promise.resolve();
  #failed = false;
  #failure: unknown;

  enqueue(action: () => Promise<void>): void {
    this.#tail = this.#tail.then(async () => {
      if (this.#failed) return;
      try {
        await action();
      } catch (error) {
        this.#failed = true;
        this.#failure = error;
      }
    });
  }

  async drain(): Promise<void> {
    await this.#tail;
    if (this.#failed) throw this.#failure;
  }
}
