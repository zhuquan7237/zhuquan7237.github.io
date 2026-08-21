import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

export interface ProviderInfo {
  id: string;
  name: string;
  baseURL: string;
  modelCount: number;
  models: string[];
}

export interface SyncResult {
  success: boolean;
  count: number;
  providers: string[];
  error?: string;
  details?: { id: string; added: number; total: number }[];
}

function resolveSettingsFile(dshHome?: string): string {
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "settings.yaml");
}

export async function getProvidersInfo(dshHome?: string): Promise<ProviderInfo[]> {
  const filePath = resolveSettingsFile(dshHome);
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = (yaml.load(content) || {}) as Record<string, any>;
    const providers = parsed.models?.providers || [];
    return providers.map((p: any) => ({
      id: p.id || p.name || "unknown",
      name: p.name || p.id || "Unknown Provider",
      baseURL: p.baseURL || "",
      modelCount: Array.isArray(p.models) ? p.models.length : 0,
      models: Array.isArray(p.models) ? p.models.map((m: any) => (typeof m === "string" ? m : m?.id || "")) : [],
    }));
  } catch {
    return [];
  }
}

export async function syncAllProviderModels(dshHome?: string): Promise<SyncResult> {
  const filePath = resolveSettingsFile(dshHome);
  if (!fs.existsSync(filePath)) {
    return { success: false, count: 0, providers: [], error: `配置文件不存在: ${filePath}` };
  }

  let content: string;
  let parsed: Record<string, any>;
  try {
    content = fs.readFileSync(filePath, "utf8");
    parsed = (yaml.load(content) || {}) as Record<string, any>;
  } catch (err: any) {
    return { success: false, count: 0, providers: [], error: `读取配置文件失败: ${err?.message || err}` };
  }

  if (!parsed.models || !Array.isArray(parsed.models.providers)) {
    return { success: true, count: 0, providers: [], error: "未找到任何模型接口配置" };
  }

  let totalNew = 0;
  const updatedProviders: string[] = [];
  const details: { id: string; added: number; total: number }[] = [];

  for (const provider of parsed.models.providers) {
    if (!provider.baseURL) continue;

    let url = provider.baseURL.trim().replace(/\/+$/, "");
    if (!url.endsWith("/models")) {
      url = `${url}/models`;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider.apiKey) {
      headers["Authorization"] = `Bearer ${provider.apiKey}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        // Try fallback without /v1/models if applicable
        continue;
      }

      const data = (await res.json()) as any;
      const modelItems = Array.isArray(data) ? data : data?.data || data?.models || [];
      const remoteIds: string[] = [];

      for (const item of modelItems) {
        const id = typeof item === "string" ? item : item?.id || item?.name;
        if (id && typeof id === "string" && !remoteIds.includes(id)) {
          remoteIds.push(id);
        }
      }

      if (remoteIds.length === 0) continue;

      const currentModels: any[] = Array.isArray(provider.models) ? provider.models : [];
      const currentIds = new Set(
        currentModels.map((m: any) => (typeof m === "string" ? m : m?.id || ""))
      );

      let addedCount = 0;
      for (const remoteId of remoteIds) {
        if (!currentIds.has(remoteId)) {
          currentModels.push({ id: remoteId, name: remoteId });
          currentIds.add(remoteId);
          addedCount += 1;
        }
      }

      provider.models = currentModels;
      totalNew += addedCount;
      updatedProviders.push(provider.id || provider.name || provider.baseURL);
      details.push({ id: provider.id || provider.name, added: addedCount, total: currentModels.length });
    } catch {
      // Ignore individual provider network timeout/errors
    }
  }

  if (totalNew > 0) {
    try {
      const dump = yaml.dump(parsed, { indent: 2, lineWidth: -1, noRefs: true });
      fs.writeFileSync(filePath, dump, "utf8");
    } catch (err: any) {
      return { success: false, count: totalNew, providers: updatedProviders, error: `写入配置文件失败: ${err?.message || err}` };
    }
  }

  return {
    success: true,
    count: totalNew,
    providers: updatedProviders,
    details,
  };
}
