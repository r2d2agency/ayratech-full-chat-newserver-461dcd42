export interface AppVersion {
  version: string;
  commit: string;
  commitShort: string;
  buildId: string;
  buildTime: string;
  dirty: boolean;
  web?: string;
  promoter?: string;
  timestamp?: number;
}

let cachedVersion: AppVersion | null = null;

export async function loadAppVersion(): Promise<AppVersion | null> {
  if (cachedVersion) return cachedVersion;

  try {
    const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    cachedVersion = await response.json() as AppVersion;
    return cachedVersion;
  } catch {
    return null;
  }
}

export function formatAppVersion(version: AppVersion | null): string {
  if (!version) return "Versão indisponível";
  const date = new Date(version.buildTime);
  const builtAt = Number.isNaN(date.getTime())
    ? ""
    : ` · ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date)}`;
  return `v${version.version} · build ${version.commitShort}${builtAt}`;
}
