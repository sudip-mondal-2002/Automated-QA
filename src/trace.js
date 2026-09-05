import { redactSensitive } from "./references.js";

export function traceEvent({ seq, stage, event, level = "info", message = "", data, now = () => new Date() } = {}) {
  const at = now();
  const ts = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  return {
    seq,
    ts,
    stage,
    event,
    level,
    message,
    ...(data === undefined ? {} : { data }),
  };
}

export function createTracer({ now = () => new Date(), writeLine, sensitiveValues = [] } = {}) {
  let sequence = 0;
  let degraded = false;
  const buffered = [];

  const emit = async (stage, event, payload = {}) => {
    sequence += 1;
    const { level = "info", message = "", data } = payload ?? {};
    const entry = traceEvent({
      seq: sequence,
      stage,
      event,
      level,
      message,
      ...(data === undefined ? {} : { data }),
      now,
    });
    const redacted = redactSensitive(entry, sensitiveValues);
    const line = `${JSON.stringify(redacted)}\n`;
    if (typeof writeLine !== "function") {
      buffered.push(line);
      return redacted;
    }
    try {
      await writeLine(line);
    } catch {
      degraded = true;
      buffered.push(line);
    }
    return redacted;
  };

  const close = async () => ({ degraded, buffered: [...buffered] });

  return {
    emit,
    close,
    get seq() {
      return sequence;
    },
    get degraded() {
      return degraded;
    },
    get buffered() {
      return [...buffered];
    },
  };
}
