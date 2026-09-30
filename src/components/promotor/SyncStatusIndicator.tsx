import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/offline-db";
import { useOfflineSync } from "@/hooks/use-offline-sync";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, RefreshCw, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

export function SyncStatusIndicator({ className }: { className?: string }) {
  const { isOnline, isSyncing, sync } = useOfflineSync();
  const accountKey = (() => {
    const userId = localStorage.getItem('user_id') || localStorage.getItem('promotor_employee_id') || localStorage.getItem('employee_id');
    const organizationId = localStorage.getItem('organization_id') || localStorage.getItem('org_id') || '';
    const authDomain = localStorage.getItem('auth_type') || 'promotor';
    return userId ? `${authDomain}:${organizationId}:${userId}` : null;
  })();
  const pendingUploads = useLiveQuery(() => db.pending_uploads.toArray().then(rows => rows.filter(row => row.accountKey === accountKey).length), [accountKey]) || 0;
  const pendingCalls = useLiveQuery(() => db.pending_api_calls.toArray().then(rows => rows.filter(row => row.accountKey === accountKey).length), [accountKey]) || 0;
  const totalPending = pendingUploads + pendingCalls;

  if (totalPending > 0) {
    return (
      <Badge 
        variant="outline" 
        className={cn(
          "gap-1.5 py-1 px-3 border-yellow-500/50 bg-yellow-500/10 text-yellow-700 font-medium cursor-pointer animate-pulse h-7", 
          className
        )}
        onClick={() => isOnline && sync({ force: true })}
      >
        <RefreshCw className={cn("h-3.5 w-3.5", isSyncing && "animate-spin")} />
        {isOnline
          ? (isSyncing ? `Sincronizando ${totalPending}...` : `${totalPending} pendente(s)`)
          : `Aguardando conexão (${totalPending})`}
      </Badge>
    );
  }

  if (!isOnline) {
    return (
      <Badge variant="outline" className={cn("gap-1.5 py-1 px-3 border-destructive/50 bg-destructive/5 text-destructive font-medium h-7", className)}>
        <WifiOff className="h-3.5 w-3.5" />
        Offline
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={cn("gap-1.5 py-1 px-3 border-green-500/50 bg-green-500/10 text-green-700 font-medium h-7", className)}>
      <CheckCircle2 className="h-3.5 w-3.5" />
      OK
    </Badge>
  );
}
