import { QaError } from "./errors.js";

const REQUIRED_METHODS = ["act", "observe", "screenshot"];

export class NativeExecutor {
  constructor(kind, driver) {
    if (!new Set(["web", "desktop"]).has(kind)) {
      throw new QaError("INVALID_NATIVE_EXECUTOR", `Unsupported native executor kind: ${kind}`);
    }
    this.kind = kind;
    this.driver = driver ?? {};
  }

  async availability() {
    const missing = REQUIRED_METHODS.filter((method) => typeof this.driver[method] !== "function");
    if (missing.length > 0) {
      return { available: false, explanation: `Native ${this.kind} executor is missing: ${missing.join(", ")}` };
    }
    if (typeof this.driver.isAvailable === "function") {
      const result = await this.driver.isAvailable();
      if (result === false) return { available: false, explanation: `Native ${this.kind} capability is unavailable` };
      if (result && typeof result === "object" && result.available === false) return result;
    }
    return {
      available: true,
      unsupported: [
        ...(typeof this.driver.consoleErrors === "function" ? [] : ["console inspection"]),
        ...(typeof this.driver.networkErrors === "function" ? [] : ["network inspection"]),
      ],
    };
  }

  connect(target, context) {
    return this.driver.connect?.(target, context);
  }

  act(intent, context) {
    return this.driver.act(intent, context);
  }

  observe(expectation, context) {
    return this.driver.observe(expectation, context);
  }

  screenshot(context) {
    return this.driver.screenshot(context);
  }

  supports(operation) {
    return typeof this.driver[operation] === "function";
  }

  rediscover(intent, context) {
    return this.driver.rediscover?.(intent, context);
  }

  recover(intent, target, context) {
    if (typeof this.driver.recover === "function") return this.driver.recover(intent, target, context);
    return this.driver.act(intent, { ...context, recovery: { target } });
  }

  waitFor(expectation, context) {
    return this.driver.waitFor?.(expectation, context);
  }

  compareDesign(request, context) {
    return this.driver.compareDesign?.(request, context);
  }

  consoleErrors(context) {
    return this.driver.consoleErrors?.(context);
  }

  networkErrors(context) {
    return this.driver.networkErrors?.(context);
  }

  close(context) {
    return this.driver.close?.(context);
  }
}

export function createNativeWebExecutor(driver) {
  return new NativeExecutor("web", driver);
}

export function createNativeDesktopExecutor(driver) {
  return new NativeExecutor("desktop", driver);
}

export async function detectNativeCapability(environment, executor) {
  const kind = environment?.type;
  if (!executor) {
    const name = kind === "desktop" ? "computer use" : "Browser or Chrome";
    return { available: false, explanation: `No native ${name} capability was provided` };
  }
  if (executor.kind !== kind) {
    return {
      available: false,
      explanation: `Environment requires a native ${kind} executor, but ${executor.kind ?? "an unknown capability"} was provided`,
    };
  }
  if (typeof executor.availability !== "function") {
    return { available: false, explanation: `Native ${kind} executor does not expose capability detection` };
  }
  return executor.availability();
}
