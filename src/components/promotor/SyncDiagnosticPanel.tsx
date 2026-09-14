import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Wifi, WifiOff, CheckCircle2, Clock, AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePromotorPunches } from "@/hooks/use-promotor";
import { format, subDays } from "date-fns";
import { useState, useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/offline-db";
import { useOfflineSync } from "@/hooks/use-offline-sync";

export function SyncDiagnosticPanel() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const startDate = subDays(new Date(), 7).toISOString().slice(0, 10);
  const { data: punches = [], isLoading, refetch } = usePromotorPunches({ start_date: startDate });

  useEffect(() => {
    const onOn = () => setIsOnline(true);
    const onOff = () => setIsOnline(false);
    window.addEventListener('online', onOn);
    window.addEventListener('offline', onOff);
    return () => { window.removeEventListener('online', onOn); window.removeEventListener('offline', onOff); };
  }, []);

  const synced = punches.filter((p: any) => p.sync_status === 'synced');
  const pending = punches.filter((p: any) => p.sync_status === 'pending');
  const offline = punches.filter((p: any) => p.is_offline);

  // Check offline queue in IndexedDB via our hook
  const { sync, isSyncing } = useOfflineSync();
  const pendingUploads = useLiveQuery(() => db.pending_uploads.count()) || 0;
  const pendingCalls = useLiveQuery(() => db.pending_api_calls.count()) || 0;
  const failedUploads = useLiveQuery(() =>
    db.pending_uploads
      .where('status')
      .equals('failed')
      .reverse()
      .sortBy('timestamp'),
  ) || [];
  const failedCalls = useLiveQuery(() =>
    db.pending_api_calls
      .where('status')
      .equals('failed')
      .reverse()
      .sortBy('timestamp'),
  ) || [];
  const totalPending = pendingUploads + pendingCalls;
  const recentFailures = [
    ...failedUploads.slice(0, 3).map((item: any) => ({
      id: `upload-${item.id}`,
      type: 'Upload de foto',
      label: item.fileName || item.localId || 'arquivo',
      error: item.error || 'Falha no upload',
      timestamp: item.timestamp,
    })),
    ...failedCalls.slice(0, 3).map((item: any) => ({
      id: `call-${item.id}`,
      type: 'Envio do checklist',
      label: item.url || 'API',
      error: item.error || 'Falha na chamada',
      timestamp: item.timestamp,
    })),
  ]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 5);

  return (
    <Card>
      <CardHeader className="p-3 pb-1">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Central de Diagnóstico
          </span>
          <Button variant="ghost" size="sm" onClick={() => refetch()} className="h-7 text-xs">
            Atualizar
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-3">
        {/* Connection Status */}
        <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
          {isOnline ? (
            <>
              <Wifi className="h-5 w-5 text-green-600" />
              <div>
                <p className="text-sm font-medium text-green-600">Online</p>
                <p className="text-[10px] text-muted-foreground">Conectado ao servidor</p>
              </div>
            </>
          ) : (
            <>
              <WifiOff className="h-5 w-5 text-red-600" />
              <div>
                <p className="text-sm font-medium text-red-600">Offline</p>
                <p className="text-[10px] text-muted-foreground">Dados serão sincronizados quando a conexão voltar</p>
              </div>
            </>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-2 rounded-lg bg-green-50 dark:bg-green-950/20">
            <CheckCircle2 className="h-4 w-4 mx-auto text-green-600 mb-1" />
            <p className="text-lg font-bold text-green-700">{synced.length}</p>
            <p className="text-[10px] text-green-600">Sincronizados</p>
          </div>
          <div className="text-center p-2 rounded-lg bg-yellow-50 dark:bg-yellow-950/20">
            <Clock className="h-4 w-4 mx-auto text-yellow-600 mb-1" />
            <p className="text-lg font-bold text-yellow-700">{pending.length + totalPending}</p>
            <p className="text-[10px] text-yellow-600">Pendentes</p>
          </div>
          <div className="text-center p-2 rounded-lg bg-blue-50 dark:bg-blue-950/20">
            <WifiOff className="h-4 w-4 mx-auto text-blue-600 mb-1" />
            <p className="text-lg font-bold text-blue-700">{offline.length}</p>
            <p className="text-[10px] text-blue-600">Originados Offline</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border p-2 text-center">
            <p className="text-base font-bold">{pendingUploads}</p>
            <p className="text-[10px] text-muted-foreground">Uploads na fila</p>
          </div>
          <div className="rounded-lg border p-2 text-center">
            <p className="text-base font-bold">{pendingCalls}</p>
            <p className="text-[10px] text-muted-foreground">Chamadas API na fila</p>
          </div>
        </div>

        {/* Offline Queue Alert */}
        {totalPending > 0 && (
          <div className="flex flex-col gap-2 p-2 rounded-lg bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-yellow-600 flex-shrink-0" />
              <div>
                <p className="text-xs font-medium text-yellow-700">{totalPending} item(s) travados na fila local</p>
                <p className="text-[10px] text-yellow-600">Inclui fotos e checklists pendentes.</p>
              </div>
            </div>
            <Button 
              size="sm" 
              variant="outline" 
              className="w-full text-xs h-8 border-yellow-300 bg-yellow-100 hover:bg-yellow-200 text-yellow-800"
              onClick={() => sync({ force: true })}
              disabled={isSyncing || !isOnline}
            >
              {isSyncing ? <Loader2 className="h-3 w-3 animate-spin mr-2" /> : <RefreshCw className="h-3 w-3 mr-2" />}
              Tentar Sincronizar Agora
            </Button>
          </div>
        )}

        {recentFailures.length > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <div>
                <p className="text-xs font-medium text-destructive">
                  {failedUploads.length + failedCalls.length} falha(s) recentes na sincronização
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Isso ajuda a identificar por que as fotos não estão subindo.
                </p>
              </div>
            </div>
            <div className="space-y-1">
              {recentFailures.map((failure) => (
                <div key={failure.id} className="rounded border bg-background/80 p-2 text-[10px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{failure.type}</span>
                    <span className="text-muted-foreground">
                      {failure.timestamp ? format(new Date(failure.timestamp), 'dd/MM HH:mm') : 'agora'}
                    </span>
                  </div>
                  <p className="truncate text-muted-foreground">{failure.label}</p>
                  <p className="text-destructive mt-1 break-words">{failure.error}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Punches */}
        {isLoading ? (
          <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : punches.length > 0 ? (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Últimos registros (7 dias)</p>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {punches.slice(0, 10).map((p: any) => (
                <div key={p.id} className="flex items-center justify-between text-xs p-1.5 bg-muted/20 rounded">
                  <div className="flex items-center gap-2">
                    <span>{format(new Date(p.punched_at), 'dd/MM HH:mm')}</span>
                    <span className="text-muted-foreground">{p.punch_type}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {p.is_offline && <Badge variant="outline" className="text-[9px] h-4">Offline</Badge>}
                    <Badge variant={p.sync_status === 'synced' ? 'default' : 'secondary'} className="text-[9px] h-4">
                      {p.sync_status === 'synced' ? '✓' : '⏳'}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-center text-muted-foreground py-2">Nenhum registro nos últimos 7 dias</p>
        )}
      </CardContent>
    </Card>
  );
}
