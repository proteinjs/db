import { Logger } from '@proteinjs/logger';

/**
 * THE detachment idiom for deliberately fire-and-forget db work — one owner.
 *
 * Under node's default unhandled-rejection policy (node 15+ `--unhandled-rejections=throw`;
 * node 24 in production), a detached db operation that REJECTS — e.g. a write that trips the
 * driver's op deadline (`SpannerConfig.opDeadlineMs`, default 60s) — is an unhandled rejection
 * that KILLS THE PROCESS (observed live: a detached write past the 60s driver deadline aborted
 * the server). Detaching is a legitimate, named decision — the caller does not need the outcome
 * to proceed — but the rejection still needs a terminal observer. This class is that observer:
 * every deliberately un-awaited db operation routes through `run`, which invokes the work,
 * terminally catches (synchronous throws included), and logs the failure WITH the caller's
 * context — never process death, never a silent swallow.
 *
 * NOT for outcomes the caller depends on: work whose failure must alter behavior is awaited at
 * the call site. `run` returns void by design, so a detached result cannot be accidentally
 * consumed.
 */
export class DetachedDbOps {
  private static logger = new Logger({ name: 'DetachedDbOps' });

  /**
   * Run `work` detached. Failures — a rejected promise or a synchronous throw — are terminally
   * logged under `description` with `context`, never rethrown and never left unhandled.
   */
  static run(description: string, work: () => Promise<unknown>, context?: Record<string, unknown>): void {
    let result: Promise<unknown>;
    try {
      result = work();
    } catch (error) {
      this.observe(description, error, context);
      return;
    }
    result.catch((error) => this.observe(description, error, context));
  }

  // --- helpers last ---

  private static observe(description: string, error: unknown, context?: Record<string, unknown>): void {
    this.logger.error({
      message: `Detached db operation failed: ${description}`,
      error,
      ...(context ? { obj: context } : {}),
    });
  }
}
