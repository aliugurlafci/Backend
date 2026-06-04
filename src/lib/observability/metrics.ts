/**
 * Phase 11 — metrics.
 *
 * Minimal in-process counters and histograms. The snapshot is exposed via the
 * health/metrics API. In production this would be an OpenTelemetry meter.
 */
interface Histogram {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export class Metrics {
  private counters = new Map<string, number>();
  private histograms = new Map<string, Histogram>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, value: number): void {
    const h = this.histograms.get(name) ?? { count: 0, sum: 0, min: Infinity, max: -Infinity };
    h.count += 1;
    h.sum += value;
    h.min = Math.min(h.min, value);
    h.max = Math.max(h.max, value);
    this.histograms.set(name, h);
  }

  snapshot(): {
    counters: Record<string, number>;
    histograms: Record<string, Histogram & { avg: number }>;
  } {
    const histograms: Record<string, Histogram & { avg: number }> = {};
    for (const [name, h] of this.histograms) {
      histograms[name] = { ...h, avg: h.count ? h.sum / h.count : 0 };
    }
    return { counters: Object.fromEntries(this.counters), histograms };
  }
}

export const metrics = new Metrics();
