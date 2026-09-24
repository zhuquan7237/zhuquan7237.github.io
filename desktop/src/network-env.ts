import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 桥接 store 里的网络路由配置（mobile-bridge.json 的 network 段）。 */
export interface BridgeNetworkConfig {
  proxyUrl?: string;
  routes?: Record<string, "direct" | "proxy">;
  /** 桥接算好的「绕过代理」主机列表（引擎用 NO_PROXY 语义）。 */
  noProxyHosts?: string[];
  revision?: number;
  restartRequestedAt?: number | null;
}

/** 读桥接 store；缺失/损坏时给空配置（= 不设置代理，保持旧行为）。 */
export function readBridgeNetwork(dshHome: string): BridgeNetworkConfig {
  try {
    const raw = JSON.parse(readFileSync(join(dshHome, "mobile-bridge.json"), "utf8")) as {
      network?: BridgeNetworkConfig;
    };
    return raw.network ?? {};
  } catch {
    return {};
  }
}

/**
 * 引擎启动环境。proxyUrl 为空 → 不设置任何代理变量（全直连）。
 * 注意：@deepseek-ai/dsh-http-proxy 只在引擎进程启动时解析一次这些变量，
 * 所以路由改动通过「桌面壳重启引擎」生效——这里永远是唯一的注入点。
 */
export function engineNetworkEnv(network: BridgeNetworkConfig): NodeJS.ProcessEnv {
  const proxyUrl = String(network.proxyUrl ?? "").trim();
  if (proxyUrl === "") return {};
  const bypass = ["127.0.0.1", "localhost", "::1", "[::1]", ...(network.noProxyHosts ?? [])];
  const noProxy = [...new Set(bypass)].join(",");
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
