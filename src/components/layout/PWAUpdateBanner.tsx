import { useState, useEffect, useCallback } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { RefreshCw, Download, Sparkles, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { db } from "@/lib/offline-db";

const isInIframe = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

const isPreviewHost =
  window.location.hostname.includes("id-preview--") ||
  window.location.hostname.includes("lovableproject.com");

const shouldWatchForUpdates = !isInIframe;

export function PWAUpdateBanner() {
  const [showPopup, setShowPopup] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const [newVersion, setNewVersion] = useState<{ web: string, promoter: string } | null>(null);
  const [deferredUpdate, setDeferredUpdate] = useState(false);
  const { updateServiceWorker, needRefresh } = useRegisterSW({
    immediate: true,
    onNeedRefresh() {
      setShowPopup(true);
    },
  });

  useEffect(() => {
    if (!needRefresh || updating || deferredUpdate) return;

    // Mostra o aviso, mas não inicia a atualização sozinho. Assim o
    // colaborador pode continuar trabalhando e escolher o momento seguro,
    // sem ficar preso em "0%" caso o worker não consiga assumir o controle.
    setShowPopup(true);
  }, [needRefresh, updating, deferredUpdate]);

  const checkVersion = useCallback(async () => {
    try {
      const response = await fetch('/version.json?t=' + Date.now(), { cache: "no-store" });
      if (!response.ok) return;
      
      const data = await response.json();
      const storedVersionStr = localStorage.getItem('app-version');
      const storedVersion = storedVersionStr ? JSON.parse(storedVersionStr) : { web: '1.0.0', promoter: '1.0.0' };
      
      const isPromoter = window.location.pathname.startsWith('/promotor');
      
      let hasUpdate = false;
      if (isPromoter) {
        // Only notify promoters if the promoter version changed
        if (data.promoter !== storedVersion.promoter) {
          hasUpdate = true;
        }
      } else {
        // Notify desktop/admin if the web version changed
        if (data.web !== storedVersion.web) {
          hasUpdate = true;
        }
      }

      if (hasUpdate && !deferredUpdate) {
        setNewVersion(data);
        setShowPopup(true);
      }
    } catch (err) {
      console.error("[PWA] Error checking version:", err);
    }
  }, [deferredUpdate]);

  useEffect(() => {
    if (!shouldWatchForUpdates) return;

    // Initial check
    checkVersion();

    // iOS/Safari verifica o worker principalmente ao voltar ao primeiro plano.
    const refreshServiceWorker = () => {
      void navigator.serviceWorker?.getRegistration().then((registration) => {
        void registration?.update();
      });
      void checkVersion();
    };
    window.addEventListener("focus", refreshServiceWorker);
    document.addEventListener("visibilitychange", refreshServiceWorker);

    // Fallback para sessões longas abertas no mesmo aparelho.
    const interval = setInterval(refreshServiceWorker, 5 * 60 * 1000);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refreshServiceWorker);
      document.removeEventListener("visibilitychange", refreshServiceWorker);
    };
  }, [checkVersion]);

  const [pendingCount, setPendingCount] = useState(0);
  const [confirmForce, setConfirmForce] = useState(false);

  const handleUpdate = useCallback(async () => {
    // Bloqueia atualização se houver itens pendentes no IndexedDB — evita perda de fotos.
    try {
      const [u, c] = await Promise.all([
        db.pending_uploads.count(),
        db.pending_api_calls.count(),
      ]);
      const total = u + c;
      if (total > 0 && !confirmForce) {
        setPendingCount(total);
        setConfirmForce(true);
        return;
      }
    } catch {}

    setUpdating(true);
    setProgress(0);

    const progressInterval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 90) {
          clearInterval(progressInterval);
          return 90;
        }
        return prev + Math.random() * 15;
      });
    }, 200);

    try {
      if (needRefresh) {
        // Solicita que o worker aguardando assuma o controle. Não marca como
        // concluído antes do reload, pois o worker pode continuar aguardando.
        setProgress(90);
        setTimeout(() => updateServiceWorker(true), 300);
      setTimeout(() => window.location.reload(), 5000);
        return;
      }

      // Fallback para versão detectada pelo version.json. Recarrega sem
      // exibir "concluída" antes de a nova página ser carregada.
      setProgress(90);
      setTimeout(() => window.location.reload(), 500);
      return;
    } catch (err) {
      console.error("[PWA] Update failed:", err);
      window.location.reload();
    }
  }, [newVersion, confirmForce, needRefresh, updateServiceWorker]);

  if (!showPopup) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-300">
      <div className={cn(
        "bg-card border rounded-2xl shadow-2xl p-6 mx-4 max-w-sm w-full",
        "animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
      )}>
        <div className="flex justify-center mb-4">
          <div className={cn(
            "p-4 rounded-full",
            done ? "bg-green-500/10" : updating ? "bg-primary/10" : "bg-primary/10"
          )}>
            {done ? (
              <CheckCircle2 className="h-10 w-10 text-green-500" />
            ) : updating ? (
              <RefreshCw className="h-10 w-10 text-primary animate-spin" />
            ) : (
              <Sparkles className="h-10 w-10 text-primary" />
            )}
          </div>
        </div>

        <h3 className="text-lg font-bold text-foreground text-center">
          {done ? "Atualização concluída!" : updating ? "Atualizando..." : "Nova versão disponível!"}
        </h3>

        <p className="text-sm text-muted-foreground text-center mt-2">
          {done
            ? "O sistema foi atualizado e será recarregado."
            : updating
            ? "Preparando nova versão, aguarde..."
            : "Uma nova versão com melhorias está disponível para você."}
        </p>

        {updating && (
          <div className="mt-4">
            <Progress value={progress} className="h-2" />
            <p className="text-xs text-muted-foreground text-center mt-1">
              {Math.round(progress)}%
            </p>
          </div>
        )}

        {!updating && !done && confirmForce && (
          <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-foreground">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <strong className="text-destructive">Você tem {pendingCount} item(ns) pendente(s) de envio.</strong>
                <p className="mt-1 text-muted-foreground">
                  Se atualizar agora essas fotos podem ser perdidas. Conecte-se ao Wi-Fi ou 4G e aguarde a sincronização terminar antes de atualizar.
                </p>
              </div>
            </div>
          </div>
        )}

        {!updating && !done && (
          <div className="flex flex-col gap-2 mt-5">
            <Button
              onClick={handleUpdate}
              className={cn("w-full gap-2", confirmForce && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
            >
              <Download className="h-4 w-4" />
              {confirmForce ? "Atualizar mesmo assim" : "Atualizar agora"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => { setDeferredUpdate(true); setShowPopup(false); setConfirmForce(false); }}
            >
              {confirmForce ? "Cancelar e sincronizar depois" : "Depois"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
