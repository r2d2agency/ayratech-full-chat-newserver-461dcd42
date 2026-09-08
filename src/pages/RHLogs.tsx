import { useState } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { 
  Search, 
  RefreshCcw, 
  Monitor,
  User,
  Smartphone,
  Activity,
  ShieldCheck,
  Info,
  AlertCircle
} from "lucide-react";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRhRuntimeLogs, useRhConnectedDevices } from "@/hooks/use-rh";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const LEVEL_COLORS: Record<string, string> = {
  debug: "bg-slate-500",
  info: "bg-blue-500",
  warn: "bg-yellow-500",
  error: "bg-red-500",
  fatal: "bg-purple-600",
};

// Resume o objeto `device` (userAgent/platform) enviado pelo app cliente numa
// label curta e legível, tipo "iPhone · Safari" — antes só dava pra ver isso
// abrindo o JSON bruto em "Dados Adicionais".
function summarizeDevice(device: any): string | null {
  if (!device) return null;
  const ua: string = device.userAgent || "";
  let os = device.platform || "";
  if (/iphone/i.test(ua)) os = "iPhone";
  else if (/ipad/i.test(ua)) os = "iPad";
  else if (/android/i.test(ua)) os = "Android";
  else if (/windows/i.test(ua)) os = "Windows";
  else if (/mac ?os/i.test(ua)) os = "Mac";

  let browser = "";
  if (/CriOS/i.test(ua)) browser = "Chrome";
  else if (/FxiOS/i.test(ua)) browser = "Firefox";
  else if (/EdgiOS|Edg\//i.test(ua)) browser = "Edge";
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = "Safari";
  else if (/chrome/i.test(ua)) browser = "Chrome";
  else if (/firefox/i.test(ua)) browser = "Firefox";

  const parts = [os, browser].filter(Boolean);
  return parts.length ? parts.join(" · ") : (ua ? ua.slice(0, 40) : null);
}

export default function RHLogs() {
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedLog, setSelectedLog] = useState<any>(null);

  const { data: logs, isLoading: loadingLogs, refetch: refetchLogs } = useRhRuntimeLogs({
    level: levelFilter,
    limit: 100
  });

  const { data: devices, isLoading: loadingDevices, refetch: refetchDevices } = useRhConnectedDevices();

  const filteredLogs = logs?.filter(log => {
    if (!search) return true;
    const s = search.toLowerCase();
    const deviceLabel = summarizeDevice(log.device) || "";
    return (
      (log.message?.toLowerCase().includes(s)) ||
      (log.event?.toLowerCase().includes(s)) ||
      (log.user_email?.toLowerCase().includes(s)) ||
      (log.employee_name?.toLowerCase().includes(s)) ||
      (log.employee_id?.toLowerCase?.().includes(s)) ||
      deviceLabel.toLowerCase().includes(s) ||
      (log.device?.userAgent?.toLowerCase().includes(s))
    );
  }) || [];

  return (
    <MainLayout>
      <div className="p-6 space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Activity className="h-6 w-6 text-primary" /> Central de Diagnóstico e Logs
            </h1>
            <p className="text-muted-foreground text-sm">
              Monitore a saúde do sistema e os dispositivos conectados em tempo real.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { refetchLogs(); refetchDevices(); }} className="gap-2">
              <RefreshCcw className={`h-4 w-4 ${(loadingLogs || loadingDevices) ? 'animate-spin' : ''}`} /> Atualizar
            </Button>
          </div>
        </div>

        <Tabs defaultValue="logs" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="logs" className="flex gap-2 items-center">
              <Monitor className="h-4 w-4" /> Logs em Tempo Real
            </TabsTrigger>
            <TabsTrigger value="devices" className="flex gap-2 items-center">
              <Smartphone className="h-4 w-4" /> Dispositivos dos Promotores
            </TabsTrigger>
          </TabsList>

          <TabsContent value="logs" className="space-y-4 pt-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex flex-col md:flex-row gap-4">
                  <div className="flex-1 relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Buscar nos logs..."
                      className="pl-9"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <div className="w-full md:w-48">
                    <Select value={levelFilter} onValueChange={setLevelFilter}>
                      <SelectTrigger>
                        <SelectValue placeholder="Nível" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todos os Níveis</SelectItem>
                        <SelectItem value="error">Erros</SelectItem>
                        <SelectItem value="warn">Avisos</SelectItem>
                        <SelectItem value="info">Informações</SelectItem>
                        <SelectItem value="debug">Debug</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[180px]">Data/Hora</TableHead>
                      <TableHead className="w-[100px]">Nível</TableHead>
                      <TableHead>Evento / Mensagem</TableHead>
                      <TableHead>Usuário</TableHead>
                      <TableHead className="w-[140px]">Dispositivo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loadingLogs ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center py-8">Carregando logs...</TableCell>
                      </TableRow>
                    ) : filteredLogs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Nenhum log recente.</TableCell>
                      </TableRow>
                    ) : (
                      filteredLogs.map((log, idx) => (
                        <TableRow
                          key={log.id || `${log.ts}-${idx}`}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => setSelectedLog(log)}
                        >
                          <TableCell className="whitespace-nowrap font-mono text-xs">
                            {log.ts ? format(new Date(log.ts), "dd/MM HH:mm:ss", { locale: ptBR }) : '—'}
                          </TableCell>
                          <TableCell>
                            <Badge className={`${LEVEL_COLORS[log.level] || 'bg-slate-500'} text-white border-none text-[10px] uppercase`}>
                              {log.level}
                            </Badge>
                          </TableCell>
                          <TableCell className="max-w-[400px] truncate text-sm">
                            <span className="font-semibold mr-2">{log.event}</span>
                            <span className="text-muted-foreground">{log.message || (log.error ? log.error.message : '')}</span>
                          </TableCell>
                          <TableCell className="text-xs max-w-[200px] truncate">
                            {log.user_email || log.employee_name || (log.employee_id ? `Colaborador ${String(log.employee_id).slice(0, 8)}` : "Sistema")}
                          </TableCell>
                          <TableCell className="text-xs max-w-[140px] truncate text-muted-foreground">
                            {summarizeDevice(log.device) || (log.source === 'client' ? '—' : 'Servidor')}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="devices" className="space-y-4 pt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {loadingDevices ? (
                Array(6).fill(0).map((_, i) => (
                  <Card key={i} className="animate-pulse bg-muted h-32" />
                ))
              ) : devices?.length === 0 ? (
                <div className="col-span-full py-12 text-center text-muted-foreground">
                  Nenhum dispositivo registrado ainda.
                </div>
              ) : (
                devices?.map((dev: any, idx: number) => (
                  <Card key={idx} className="overflow-hidden hover:border-primary/50 transition-colors">
                    <CardHeader className="p-4 pb-2 space-y-0">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10">
                          <AvatarImage src={dev.photo_url} />
                          <AvatarFallback><User className="h-5 w-5" /></AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <CardTitle className="text-sm truncate">{dev.employee_name}</CardTitle>
                          <CardDescription className="text-xs truncate">{dev.employee_email}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="p-4 pt-2 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Smartphone className="h-3 w-3" />
                        <span className="truncate">{dev.device_info || 'Dispositivo Desconhecido'}</span>
                      </div>
                      <div className="flex justify-between items-center text-[10px]">
                        <div className="flex items-center gap-1">
                          <Badge variant="outline" className="text-[9px]">v{dev.app_version || '?'}</Badge>
                          <span className="text-muted-foreground">IP: {dev.ip_address || '—'}</span>
                        </div>
                        <span className="text-muted-foreground">
                          Visto em: {dev.last_seen ? format(new Date(dev.last_seen), "dd/MM HH:mm", { locale: ptBR }) : '—'}
                        </span>
                      </div>
                      <div className="pt-2 border-t border-border mt-2">
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="w-full h-7 text-[10px] gap-1"
                          onClick={() => {
                            setLevelFilter("all");
                            setSearch(dev.employee_email);
                            const logsTab = document.querySelector('[value="logs"]') as HTMLButtonElement;
                            logsTab?.click();
                          }}
                        >
                          <Activity className="h-3 w-3" /> Ver Logs deste Aparelho
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </TabsContent>
        </Tabs>

        <Dialog open={!!selectedLog} onOpenChange={() => setSelectedLog(null)}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                Detalhes do Evento
                {selectedLog && (
                  <Badge className={LEVEL_COLORS[selectedLog.level] || 'bg-slate-500'}>
                    {selectedLog.level?.toUpperCase()}
                  </Badge>
                )}
              </DialogTitle>
            </DialogHeader>

            {selectedLog && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  <div className="space-y-1">
                    <span className="text-muted-foreground block text-xs">Evento</span>
                    <span className="font-semibold">{selectedLog.event}</span>
                  </div>
                  <div className="space-y-1">
                    <span className="text-muted-foreground block text-xs">Data e Hora</span>
                    <span>{selectedLog.ts ? format(new Date(selectedLog.ts), "PPP p", { locale: ptBR }) : '—'}</span>
                  </div>
                  <div className="space-y-1">
                    <span className="text-muted-foreground block text-xs flex items-center gap-1"><User className="h-3 w-3" /> Usuário/Colaborador</span>
                    <span>
                      {selectedLog.employee_name || selectedLog.user_email || "Sistema"}
                      {selectedLog.employee_name && selectedLog.user_email && (
                        <span className="text-muted-foreground text-xs ml-1">({selectedLog.user_email})</span>
                      )}
                      {!selectedLog.employee_name && !selectedLog.user_email && selectedLog.employee_id && (
                        <span className="text-xs ml-1">ID: {selectedLog.employee_id}</span>
                      )}
                    </span>
                  </div>
                  {(selectedLog.device || selectedLog.source === 'client') && (
                    <div className="space-y-1">
                      <span className="text-muted-foreground block text-xs flex items-center gap-1"><Smartphone className="h-3 w-3" /> Dispositivo</span>
                      <span>{summarizeDevice(selectedLog.device) || "Desconhecido"}</span>
                    </div>
                  )}
                  {selectedLog.ip && (
                    <div className="space-y-1">
                      <span className="text-muted-foreground block text-xs flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Endereço IP</span>
                      <span>{selectedLog.ip}</span>
                    </div>
                  )}
                </div>

                {selectedLog.message && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold">Mensagem</h4>
                    <div className="p-3 bg-muted rounded-md text-sm whitespace-pre-wrap">
                      {selectedLog.message}
                    </div>
                  </div>
                )}

                {selectedLog.error && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold text-red-500 flex items-center gap-1">
                      <AlertCircle className="h-4 w-4" /> Erro Detalhado
                    </h4>
                    <div className="space-y-2">
                      <div className="p-3 bg-red-50 dark:bg-red-950/20 text-red-900 dark:text-red-400 rounded-md text-sm">
                        <p className="font-bold">{selectedLog.error.name}: {selectedLog.error.message}</p>
                        {selectedLog.error.detail && <p className="mt-1 text-xs">{selectedLog.error.detail}</p>}
                      </div>
                      {selectedLog.error.stack && (
                        <pre className="p-3 bg-slate-900 text-slate-100 rounded-md text-xs overflow-x-auto whitespace-pre">
                          {selectedLog.error.stack}
                        </pre>
                      )}
                    </div>
                  </div>
                )}

                {/* Demais campos do payload */}
                {Object.keys(selectedLog).filter(k => !['id', 'ts', 'level', 'event', 'message', 'error', 'userId', 'user_email', 'employee_name', 'employee_id', 'ip', 'device'].includes(k)).length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold flex items-center gap-1"><Info className="h-4 w-4" /> Dados Adicionais</h4>
                    <pre className="p-3 bg-slate-900 text-slate-100 rounded-md text-xs overflow-x-auto">
                      {JSON.stringify(
                        Object.fromEntries(
                          Object.entries(selectedLog).filter(([k]) => !['id', 'ts', 'level', 'event', 'message', 'error', 'userId', 'user_email', 'employee_name', 'employee_id', 'ip', 'device'].includes(k))
                        ), 
                        null, 
                        2
                      )}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </MainLayout>
  );
}