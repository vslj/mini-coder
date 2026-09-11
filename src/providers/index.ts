/**
 * providers/index.ts —— Provider 接口的工厂出口。
 *
 * 上层（cli/repl）只从这里拿 provider，不直接 import 具体实现——
 * 换协议/加协议只动这个文件，调用方零改动。
 */

import type { AppConfig } from "../config.js";
import type { Provider } from "../types.js";
import { createOpenAIProvider } from "./openai.js";
import { createAnthropicProvider } from "./anthropic.js";

export type { Provider } from "../types.js";

export type ProviderName = "openai" | "anthropic";

export function createProvider(name: ProviderName, cfg: AppConfig): Provider {
  switch (name) {
    case "openai":
      return createOpenAIProvider(cfg);
    case "anthropic":
      return createAnthropicProvider(cfg);
  }
}

/** 按名字建出全部 provider，供 REPL 热切换用。 */
export function createAllProviders(cfg: AppConfig): Record<ProviderName, Provider> {
  return { openai: createOpenAIProvider(cfg), anthropic: createAnthropicProvider(cfg) };
}
