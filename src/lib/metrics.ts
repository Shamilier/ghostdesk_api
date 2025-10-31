import { Counter, Registry } from "prom-client";

const registry = new Registry();

export const recordingsInitCounter = new Counter({
  name: "recordings_init_total",
  help: "Number of recording init requests",
  registers: [registry],
});

export const recordingsCompleteCounter = new Counter({
  name: "recordings_complete_total",
  help: "Number of completed recordings",
  registers: [registry],
});

export const recordingsBytesCounter = new Counter({
  name: "recordings_bytes_total",
  help: "Total bytes uploaded across recordings",
  registers: [registry],
});

export function metricsRegistry() {
  return registry;
}

export async function collectMetrics(): Promise<string> {
  return registry.metrics();
}

export function metricsContentType(): string {
  return registry.contentType;
}
