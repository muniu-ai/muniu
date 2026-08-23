// SPDX-License-Identifier: Apache-2.0

import type { TurnExecutionInput, TurnExecutionResult, TurnExecutor } from "./thread-manager.js";

export interface TurnRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly execute: (
    input: TurnExecutionInput,
    route: Readonly<{ providerId: string; modelId: string; attempt: number }>
  ) => Promise<TurnExecutionResult>;
}

export class TurnAttemptError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "TurnAttemptError";
  }
}

export interface TurnRunnerOptions {
  readonly routes: readonly TurnRoute[];
  readonly retriesPerRoute?: number;
  readonly onAttempt?: (attempt: Readonly<{
    providerId: string;
    modelId: string;
    attempt: number;
    outcome: "started" | "failed" | "completed";
  }>) => void | Promise<void>;
}

export class TurnRunner implements TurnExecutor {
  readonly #routes: readonly TurnRoute[];
  readonly #retriesPerRoute: number;
  readonly #onAttempt: TurnRunnerOptions["onAttempt"];

  constructor(options: TurnRunnerOptions) {
    if (!Array.isArray(options.routes) || options.routes.length === 0) {
      throw new TypeError("turn runner requires at least one route");
    }
    this.#routes = Object.freeze(options.routes.map((route) => Object.freeze({ ...route })));
    this.#retriesPerRoute = options.retriesPerRoute ?? 1;
    if (!Number.isSafeInteger(this.#retriesPerRoute) || this.#retriesPerRoute < 0) {
      throw new TypeError("turn retries per route must be a non-negative integer");
    }
    this.#onAttempt = options.onAttempt;
  }

  async execute(input: TurnExecutionInput): Promise<TurnExecutionResult> {
    let attempt = 0;
    let lastFailure: unknown;
    for (const route of this.#routes) {
      for (let retry = 0; retry <= this.#retriesPerRoute; retry += 1) {
        if (input.signal.aborted) return { status: "interrupted" };
        attempt += 1;
        await this.#onAttempt?.({
          providerId: route.providerId,
          modelId: route.modelId,
          attempt,
          outcome: "started"
        });
        try {
          const result = await route.execute(input, {
            providerId: route.providerId,
            modelId: route.modelId,
            attempt
          });
          await this.#onAttempt?.({
            providerId: route.providerId,
            modelId: route.modelId,
            attempt,
            outcome: "completed"
          });
          return result;
        } catch (error: unknown) {
          lastFailure = error;
          await this.#onAttempt?.({
            providerId: route.providerId,
            modelId: route.modelId,
            attempt,
            outcome: "failed"
          });
          if (!(error instanceof TurnAttemptError) || !error.retryable) {
            return { status: input.signal.aborted ? "interrupted" : "failed", error: "turn route failed" };
          }
        }
      }
    }
    return {
      status: input.signal.aborted ? "interrupted" : "failed",
      error: lastFailure instanceof Error ? "all turn routes failed" : "turn route failed"
    };
  }
}
