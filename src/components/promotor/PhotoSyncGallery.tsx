import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/offline-db";
import { useOfflineSync } from "@/hooks/use-offline-sync";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LocalImage } from "@/components/promotor/LocalImage";
import { Camera, Clock, Loader2, RefreshCw, TriangleAlert, WifiOff } from "lucide-react";

function formatWhen(timestamp?: number) {
  if (!timestamp) return "";
  try {
    return new Date(timestamp).toLocaleString("pt-BR");
  } catch {
    return "";
  }
}

export function PhotoSyncGallery() {
  const { isOnline, isSyncing, sync } = useOfflineSync();

  const pendingUploads = useLiveQuery(
    () => db.pending_uploads.orderBy("timestamp").reverse().toArray(),
    [],
    [],
  );

  const pendingPhotoCalls = useLiveQuery(
    async () => {
      const calls = await db.pending_api_calls.toArray();
      return calls.filter((call) => !!call.dependsOnUploadId).length;
    },
    [],
    0,
  );

  if (!pendingUploads.length && !pendingPhotoCalls) {
    return null;
  }

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="p-3 pb-1">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Camera className="h-4 w-4" /> Galeria de Fotos Pendentes
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => sync()}
            disabled={!isOnline || isSyncing}
          >
            {isSyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
            Reenviar
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-3">
        <div className="rounded-lg border bg-background/70 p-2 text-[11px] text-muted-foreground">
          Essas fotos ficam guardadas no aparelho enquanto ainda nao sobem para o servidor.
          Se a conexao falhar, elas continuam aqui para sincronizar depois.
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">{pendingUploads.length} foto(s) no aparelho</Badge>
          {pendingPhotoCalls > 0 && (
            <Badge variant="outline">{pendingPhotoCalls} envio(s) de checklist aguardando processamento</Badge>
          )}
          {!isOnline && (
            <Badge variant="destructive" className="gap-1">
              <WifiOff className="h-3 w-3" /> Offline
            </Badge>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {pendingUploads.map((upload) => {
            const localSrc = `local-file://${upload.localId}`;
            const isFailed = upload.status === "failed";
            const isUploading = upload.status === "uploading";
            const statusLabel = isFailed ? "Falhou" : isUploading ? "Enviando" : "Na fila";

            return (
              <div key={upload.localId} className="rounded-lg border bg-background p-2 space-y-2">
                <LocalImage
                  src={localSrc}
                  alt={upload.fileName || "Foto pendente"}
                  className="w-full h-28 rounded-md object-cover border"
                />
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant={isFailed ? "destructive" : "secondary"}>{statusLabel}</Badge>
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {formatWhen(upload.timestamp)}
                    </span>
                  </div>
                  <p className="text-[11px] font-medium truncate">{upload.fileName || "Foto sem nome"}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {upload.fileType || "image/*"} • {Math.max(1, Math.round((upload.fileData?.byteLength || upload.file?.size || 0) / 1024))} KB
                  </p>
                  {upload.error && (
                    <div className="rounded border border-destructive/30 bg-destructive/5 p-1.5 text-[10px] text-destructive flex items-start gap-1">
                      <TriangleAlert className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                      <span>{upload.error}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
