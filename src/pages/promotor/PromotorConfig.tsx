import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { usePromotorSettings, usePromotorUpdateSettings, usePromotorChangePassword, usePromotorFaceEnrollment, usePromotorSaveFaceEnrollment } from "@/hooks/use-promotor";
import { PromotorLayout } from "./PromotorLayout";
import { SyncDiagnosticPanel } from "@/components/promotor/SyncDiagnosticPanel";
import { PhotoSyncGallery } from "@/components/promotor/PhotoSyncGallery";
import { Settings, Lock, Palette, Wifi, WifiOff, Navigation, Smartphone, Loader2, Download, RefreshCw, ScanFace, CheckCircle2, ShieldCheck, Trash2, AlertTriangle } from "lucide-react";
import { FaceCaptureDialog } from "@/components/facial-recognition/FaceCaptureDialog";
import { FaceVerifyDialog } from "@/components/facial-recognition/FaceVerifyDialog";
import { resolveMediaUrl } from "@/lib/media";
import { canInstallPWA, installPWA, isPWAInstalled } from "@/lib/pwa";
import { db } from "@/lib/offline-db";
import { useOfflineSync } from "@/hooks/use-offline-sync";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Progress } from "@/components/ui/progress";
import { useLiveQuery } from "dexie-react-hooks";
import { cn } from "@/lib/utils";
import { formatAppVersion, loadAppVersion, type AppVersion } from "@/lib/app-version";

export default function PromotorConfig() {
  const [updating, setUpdating] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [confirmUpdateOpen, setConfirmUpdateOpen] = useState(false);
  const [hardResetOpen, setHardResetOpen] = useState(false);
  const [hardResetConfirmText, setHardResetConfirmText] = useState('');
  const [hardResetting, setHardResetting] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [appVersion, setAppVersion] = useState<AppVersion | null>(null);
  const { sync, isSyncing, syncProgress } = useOfflineSync();
  const { data: settings } = usePromotorSettings();
  const updateSettings = usePromotorUpdateSettings();
  const changePassword = usePromotorChangePassword();
  const { toast } = useToast();
  const navigate = useNavigate();

  const livePendingUploads = useLiveQuery(() => db.pending_uploads.count(), [], 0);
  const livePendingCalls = useLiveQuery(() => db.pending_api_calls.count(), [], 0);
  const liveFailedUploads = useLiveQuery(() => db.pending_uploads.where('status').equals('failed').count(), [], 0);
  const totalQueue = (livePendingUploads || 0) + (livePendingCalls || 0);

  useEffect(() => {
    void loadAppVersion().then(setAppVersion);
  }, []);

  const [theme, setTheme] = useState(settings?.theme || 'auto');
  const [notifications, setNotifications] = useState(settings?.notifications_enabled !== false);
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [gpsStatus, setGpsStatus] = useState('checking');
  const [pwaInstalled, setPwaInstalled] = useState(isPWAInstalled());
  const [canInstall, setCanInstall] = useState(canInstallPWA());

  // Biometria facial
  const { data: faceStatus, refetch: refetchFace } = usePromotorFaceEnrollment();
  const saveFace = usePromotorSaveFaceEnrollment();
  const [faceCaptureOpen, setFaceCaptureOpen] = useState(false);
  const [faceVerifyOpen, setFaceVerifyOpen] = useState(false);
  const [pendingFace, setPendingFace] = useState<{ descriptor: number[]; landmarks: number[][]; imageDataUrl: string; geometricProfile: Record<string, number> } | null>(null);

  const employee = JSON.parse(localStorage.getItem('promotor_employee') || '{}');

  useEffect(() => {
    if (settings) {
      setTheme(settings.theme || 'auto');
      setNotifications(settings.notifications_enabled !== false);
    }
  }, [settings]);

  useEffect(() => {
    const onOn = () => setIsOnline(true);
    const onOff = () => setIsOnline(false);
    window.addEventListener('online', onOn);
    window.addEventListener('offline', onOff);

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        () => setGpsStatus('active'),
        (err) => setGpsStatus(err.code === 1 ? 'denied' : 'off')
      );
    } else {
      setGpsStatus('unavailable');
    }

    // Re-check PWA install status periodically
    const pwaInterval = setInterval(() => {
      setCanInstall(canInstallPWA());
      setPwaInstalled(isPWAInstalled());
    }, 2000);

    return () => { window.removeEventListener('online', onOn); window.removeEventListener('offline', onOff); clearInterval(pwaInterval); };
  }, []);

  // Apply theme to document
  useEffect(() => {
    const root = document.documentElement;
    let effective: 'light' | 'dark';
    if (theme === 'claro') {
      effective = 'light';
    } else if (theme === 'escuro') {
      effective = 'dark';
    } else {
      effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    root.classList.remove('light', 'dark');
    root.classList.add(effective);
    localStorage.setItem('promotor-theme', theme);
  }, [theme]);

  const handleSaveSettings = async () => {
    try {
      await updateSettings.mutateAsync({ theme, notifications_enabled: notifications });
      toast({ title: 'Configurações salvas!' });
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const handleChangePassword = async () => {
    if (!newPwd || newPwd.length < 6) {
      toast({ title: 'A nova senha deve ter ao menos 6 caracteres', variant: 'destructive' });
      return;
    }
    try {
      await changePassword.mutateAsync({ current_password: currentPwd, new_password: newPwd });
      toast({ title: 'Senha alterada com sucesso!' });
      setCurrentPwd(''); setNewPwd('');
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    }
  };

  const handleInstallPWA = async () => {
    const accepted = await installPWA();
    if (accepted) {
      toast({ title: 'App instalado com sucesso!' });
      setPwaInstalled(true);
    }
  };

  const checkPending = async () => {
    const [u, c] = await Promise.all([
      db.pending_uploads.count(),
      db.pending_api_calls.count(),
    ]);
    return u + c;
  };

  const handleForceUpdateClick = async () => {
    const total = await checkPending();
    setPendingCount(total);
    if (total > 0) {
      setConfirmUpdateOpen(true);
      return;
    }
    doForceUpdate();
  };

  const handleTrySyncFirst = async () => {
    setConfirmUpdateOpen(false);
    toast({ title: 'Tentando enviar itens pendentes...', description: 'Aguarde alguns segundos e verifique novamente.' });
    try {
      await sync({ force: true });
      const remaining = await checkPending();
      if (remaining === 0) {
        toast({ title: '✅ Tudo sincronizado!', description: 'Agora é seguro atualizar.' });
      } else {
        setPendingCount(remaining);
        setConfirmUpdateOpen(true);
      }
    } catch (err: any) {
      toast({ title: 'Falha ao sincronizar', description: err.message, variant: 'destructive' });
    }
  };

  const doForceUpdate = async () => {
    setConfirmUpdateOpen(false);
    setUpdating(true);
    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(r => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      const token = localStorage.getItem('promotor_token');
      const emp = localStorage.getItem('promotor_employee');
      const thm = localStorage.getItem('promotor-theme');
      localStorage.clear();
      if (token) localStorage.setItem('promotor_token', token);
      if (emp) localStorage.setItem('promotor_employee', emp);
      if (thm) localStorage.setItem('promotor-theme', thm);
      // IMPORTANTE: não apagamos IndexedDB (AyraOfflineDB) — fotos pendentes ficam preservadas.
      toast({ title: '✅ Sistema atualizado!', description: 'Recarregando...' });
      setTimeout(() => window.location.reload(), 1000);
    } catch (err: any) {
      toast({ title: 'Erro ao atualizar', description: err.message, variant: 'destructive' });
      setUpdating(false);
    }
  };

  const openHardReset = async () => {
    const total = await checkPending();
    setQueueCount(total);
    setHardResetConfirmText('');
    setHardResetOpen(true);
  };

  const doHardReset = async () => {
    setHardResetting(true);
    try {
      // 1) Apaga toda a fila offline (IndexedDB Dexie)
      await Promise.all([
        db.pending_uploads.clear(),
        db.pending_api_calls.clear(),
        db.upload_mappings.clear(),
      ]);
      // 2) Remove qualquer IndexedDB residual do app
      try {
        if ('databases' in indexedDB) {
          // @ts-ignore
          const dbs = await indexedDB.databases();
          await Promise.all(
            (dbs || []).map((d: any) => d?.name && indexedDB.deleteDatabase(d.name))
          );
        } else {
          (indexedDB as any).deleteDatabase('AyraOfflineDB');
        }
      } catch {}
      // 3) Service workers + caches
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      // 4) localStorage — preserva token/employee/tema para não deslogar
      const token = localStorage.getItem('promotor_token');
      const emp = localStorage.getItem('promotor_employee');
      const thm = localStorage.getItem('promotor-theme');
      localStorage.clear();
      sessionStorage.clear();
      if (token) localStorage.setItem('promotor_token', token);
      if (emp) localStorage.setItem('promotor_employee', emp);
      if (thm) localStorage.setItem('promotor-theme', thm);

      toast({ title: '✅ Fila limpa e app resetado', description: 'Recarregando...' });
      setTimeout(() => window.location.reload(), 800);
    } catch (err: any) {
      toast({ title: 'Erro no reset', description: err.message, variant: 'destructive' });
      setHardResetting(false);
    }
  };


  const handleFaceCaptured = (data: { descriptor: number[]; landmarks: number[][]; imageDataUrl: string; geometricProfile: Record<string, number> }) => {
    setPendingFace(data);
    setFaceCaptureOpen(false);
    // dispara teste de verificação automaticamente
    setTimeout(() => setFaceVerifyOpen(true), 200);
  };

  const handleFaceVerified = async (result: { match: boolean; score: number; imageDataUrl: string }) => {
    setFaceVerifyOpen(false);
    if (!pendingFace) return;
    if (!result.match || result.score < 70) {
      toast({
        title: '❌ Teste falhou',
        description: `Pontuação ${result.score.toFixed(0)}%. Recapture a foto com melhor iluminação e enquadramento.`,
        variant: 'destructive',
      });
      setPendingFace(null);
      return;
    }
    try {
      await saveFace.mutateAsync({
        descriptor: pendingFace.descriptor,
        landmarks: pendingFace.landmarks,
        imageDataUrl: pendingFace.imageDataUrl,
        geometricProfile: pendingFace.geometricProfile,
        selfTestScore: result.score,
      });
      toast({ title: '✅ Biometria cadastrada!', description: `Validação aprovada com ${result.score.toFixed(0)}%.` });
      setPendingFace(null);
      refetchFace();
    } catch (err: any) {
      toast({ title: 'Erro ao salvar', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <PromotorLayout>
      <div className="p-4 max-w-lg mx-auto space-y-4">
        <h1 className="text-lg font-bold flex items-center gap-2"><Settings className="h-5 w-5" /> Configurações</h1>

        {/* PWA Install */}
        {!pwaInstalled && (
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="p-3 flex items-center gap-3">
              <Download className="h-6 w-6 text-primary flex-shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium">Instalar Aplicativo</p>
                <p className="text-[10px] text-muted-foreground">Adicione à tela inicial para acesso rápido e offline</p>
              </div>
              {canInstall ? (
                <Button size="sm" onClick={handleInstallPWA}>Instalar</Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => {
                  const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent);
                  if (isIOSDevice) {
                    toast({ title: '📱 Como instalar no iPhone', description: 'No Safari, toque em 📤 (Compartilhar) e depois em "Adicionar à Tela de Início"' });
                  } else {
                    toast({ title: '📱 Como instalar', description: 'No menu do navegador (⋮), toque em "Instalar app" ou "Adicionar à tela inicial"' });
                  }
                }}>Como instalar</Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Profile Info */}
        <Card>
          <CardHeader className="p-3 pb-1"><CardTitle className="text-sm">Perfil</CardTitle></CardHeader>
          <CardContent className="p-3 pt-0 space-y-1 text-sm">
            <p><strong>Nome:</strong> {employee.name}</p>
            <p><strong>CPF:</strong> {employee.cpf}</p>
            <p><strong>E-mail:</strong> {employee.email}</p>
            <p><strong>Perfil:</strong> {employee.profile}</p>
          </CardContent>
        </Card>

        {/* Sync Diagnostic */}
        <SyncDiagnosticPanel />
        <PhotoSyncGallery />

        {/* Theme */}
        <Card>
          <CardHeader className="p-3 pb-1"><CardTitle className="text-sm flex items-center gap-2"><Palette className="h-4 w-4" /> Tema</CardTitle></CardHeader>
          <CardContent className="p-3 pt-0 space-y-3">
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="claro">☀️ Claro</SelectItem>
                <SelectItem value="escuro">🌙 Escuro</SelectItem>
                <SelectItem value="auto">🔄 Automático (sistema)</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center justify-between">
              <Label>Notificações</Label>
              <Switch checked={notifications} onCheckedChange={setNotifications} />
            </div>
            <Button onClick={handleSaveSettings} size="sm" className="w-full" disabled={updateSettings.isPending}>
              {updateSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Salvar Preferências
            </Button>
          </CardContent>
        </Card>


        {/* Biometria Facial */}
        <Card className={faceStatus?.enrolled ? "border-green-500/40 bg-green-500/5" : "border-primary/30 bg-primary/5"}>
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-sm flex items-center gap-2">
              <ScanFace className="h-4 w-4" /> Biometria Facial
              {faceStatus?.enrolled && <CheckCircle2 className="h-4 w-4 text-green-600 ml-auto" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-3">
            {faceStatus?.enrolled ? (
              <>
                <div className="flex items-center gap-3">
                  {faceStatus.face_photo_url && (
                    <img
                      src={resolveMediaUrl(faceStatus.face_photo_url) || faceStatus.face_photo_url}
                      alt="Foto facial"
                      className="h-16 w-16 rounded-full object-cover border-2 border-green-500"
                    />
                  )}
                  <div className="flex-1">
                    <p className="text-sm font-medium text-green-700 dark:text-green-400 flex items-center gap-1">
                      <ShieldCheck className="h-4 w-4" /> Aprovada
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Cadastrada em {faceStatus.face_enrolled_at ? new Date(faceStatus.face_enrolled_at).toLocaleString('pt-BR') : '-'}
                    </p>
                  </div>
                </div>
                <div className="rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">
                  🔒 Foto bloqueada. Para alterar, procure o RH da sua agência.
                </div>
                <Button size="sm" className="w-full" variant="outline" disabled>
                  <Lock className="h-4 w-4 mr-1" /> Cadastro travado
                </Button>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Cadastre sua biometria facial para liberar entradas em PDVs com reconhecimento. O sistema vai validar automaticamente a qualidade da foto.
                </p>
                <Button
                  size="sm"
                  className="w-full gap-2"
                  onClick={() => setFaceCaptureOpen(true)}
                  disabled={saveFace.isPending}
                >
                  {saveFace.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanFace className="h-4 w-4" />}
                  {saveFace.isPending ? 'Salvando...' : 'Capturar foto facial'}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {/* Change Password */}
        <Card>
          <CardHeader className="p-3 pb-1"><CardTitle className="text-sm flex items-center gap-2"><Lock className="h-4 w-4" /> Alterar Senha</CardTitle></CardHeader>
          <CardContent className="p-3 pt-0 space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Senha atual</Label>
              <Input type="password" value={currentPwd} onChange={e => setCurrentPwd(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Nova senha</Label>
              <Input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} />
            </div>
            <Button onClick={handleChangePassword} size="sm" className="w-full" disabled={changePassword.isPending}>
              {changePassword.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Alterar Senha
            </Button>
          </CardContent>
        </Card>

        {/* Force Sync */}
        <Card className="border-blue-300 dark:border-blue-700">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-sm flex items-center gap-2">
              <RefreshCw className={cn("h-4 w-4", isSyncing && "animate-spin")} /> Sincronização Manual
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-muted p-2">
                <div className="text-lg font-bold">{totalQueue}</div>
                <div className="text-[10px] text-muted-foreground">Na fila</div>
              </div>
              <div className="rounded-md bg-green-500/10 p-2">
                <div className="text-lg font-bold text-green-700 dark:text-green-400">{syncProgress.done}</div>
                <div className="text-[10px] text-muted-foreground">Enviadas</div>
              </div>
              <div className="rounded-md bg-destructive/10 p-2">
                <div className="text-lg font-bold text-destructive">{syncProgress.failed || (liveFailedUploads || 0)}</div>
                <div className="text-[10px] text-muted-foreground">Falharam</div>
              </div>
            </div>

            {isSyncing && syncProgress.total > 0 && (
              <div className="space-y-1">
                <Progress value={(syncProgress.done / syncProgress.total) * 100} className="h-2" />
                <p className="text-[11px] text-center text-muted-foreground">
                  Enviando {syncProgress.done} de {syncProgress.total}...
                </p>
              </div>
            )}

            <Button
              onClick={async () => {
                if (!isOnline) {
                  toast({ title: 'Sem conexão', description: 'Conecte-se a Wi-Fi ou 4G para sincronizar.', variant: 'destructive' });
                  return;
                }
                if (totalQueue === 0) {
                  toast({ title: '✅ Tudo sincronizado', description: 'Não há itens pendentes.' });
                  return;
                }
                toast({ title: 'Iniciando envio em lote...', description: `${totalQueue} item(ns) na fila.` });
                await sync({ force: true });
                const [u, c] = await Promise.all([db.pending_uploads.count(), db.pending_api_calls.count()]);
                const remaining = u + c;
                if (remaining === 0) {
                  toast({ title: '✅ Sincronização concluída', description: 'Todas as fotos foram enviadas.' });
                } else {
                  toast({ title: `${remaining} item(ns) ainda pendente(s)`, description: 'Verifique a conexão e tente novamente.', variant: 'destructive' });
                }
              }}
              disabled={isSyncing || !isOnline}
              size="sm"
              className="w-full gap-2"
            >
              {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {isSyncing ? 'Sincronizando...' : totalQueue > 0 ? `Sincronizar ${totalQueue} item(ns) agora` : 'Sincronizar agora'}
            </Button>
            {!isOnline && (
              <p className="text-[11px] text-center text-destructive">Você está offline. Conecte-se para sincronizar.</p>
            )}
          </CardContent>
        </Card>

        {/* Force Update */}
        <Card className="border-orange-300 dark:border-orange-700">
          <CardHeader className="p-3 pb-1"><CardTitle className="text-sm flex items-center gap-2"><RefreshCw className="h-4 w-4" /> Atualizar Sistema</CardTitle></CardHeader>
          <CardContent className="p-3 pt-0 space-y-2">
            <p className="text-xs text-muted-foreground">Limpa o cache do navegador, service workers e recarrega o app com a versão mais recente.</p>
            <Button onClick={handleForceUpdateClick} disabled={updating} variant="outline" size="sm" className="w-full gap-2">
              {updating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {updating ? 'Atualizando...' : 'Atualizar Agora'}
            </Button>
          </CardContent>
        </Card>

        {/* Hard Reset - Limpar Fila */}
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-sm flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" /> Reset Total (Emergência)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-2">
            <p className="text-xs text-muted-foreground">
              Use apenas se a fila de sincronização estiver travada e as fotos não subirem mesmo online.
              <strong className="text-destructive"> Todas as fotos pendentes serão apagadas permanentemente.</strong>
            </p>
            <Button onClick={openHardReset} variant="destructive" size="sm" className="w-full gap-2">
              <Trash2 className="h-4 w-4" />
              Limpar fila e resetar app
            </Button>
          </CardContent>
        </Card>

        {/* Status */}
        <Card>
          <CardHeader className="p-3 pb-1"><CardTitle className="text-sm flex items-center gap-2"><Smartphone className="h-4 w-4" /> Status do Dispositivo</CardTitle></CardHeader>
          <CardContent className="p-3 pt-0 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">{isOnline ? <Wifi className="h-4 w-4 text-green-600" /> : <WifiOff className="h-4 w-4 text-red-600" />} Conexão</span>
              <span className={isOnline ? 'text-green-600' : 'text-red-600'}>{isOnline ? 'Online' : 'Offline'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2"><Navigation className="h-4 w-4" /> GPS</span>
              <span className={gpsStatus === 'active' ? 'text-green-600' : 'text-red-600'}>
                {gpsStatus === 'active' ? 'Ativo' : gpsStatus === 'denied' ? 'Permissão negada' : 'Desligado'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2"><Download className="h-4 w-4" /> PWA</span>
              <span className={pwaInstalled ? 'text-green-600' : 'text-muted-foreground'}>{pwaInstalled ? 'Instalado' : 'Navegador'}</span>
            </div>
            <p className="text-xs text-muted-foreground">{formatAppVersion(appVersion)}</p>
          </CardContent>
        </Card>
      </div>

      <FaceCaptureDialog
        open={faceCaptureOpen}
        onOpenChange={setFaceCaptureOpen}
        onCapture={handleFaceCaptured}
        title="Cadastro Biométrico"
        description="Posicione seu rosto centralizado, com boa iluminação. O sistema validará a captura automaticamente."
      />

      {pendingFace && (
        <FaceVerifyDialog
          open={faceVerifyOpen}
          onOpenChange={(o) => { setFaceVerifyOpen(o); if (!o && pendingFace) setPendingFace(null); }}
          storedDescriptor={pendingFace.descriptor}
          storedPhotoUrl={pendingFace.imageDataUrl}
          personName="você mesmo"
          threshold={70}
          onResult={handleFaceVerified}
        />
      )}

      <AlertDialog open={confirmUpdateOpen} onOpenChange={setConfirmUpdateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>⚠️ Você tem {pendingCount} item(ns) pendente(s)</AlertDialogTitle>
            <AlertDialogDescription>
              Existem fotos ou envios que ainda não foram sincronizados com o servidor.
              Se você atualizar agora, esses itens podem ser perdidos.
              <br /><br />
              Recomendamos tentar sincronizar primeiro. Verifique se está online (Wi-Fi ou 4G) antes de continuar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-col">
            <Button onClick={handleTrySyncFirst} disabled={isSyncing} className="w-full">
              {isSyncing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Tentar sincronizar agora
            </Button>
            <AlertDialogCancel className="w-full mt-0">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={doForceUpdate}
              className="w-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Atualizar mesmo assim (perder pendentes)
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={hardResetOpen} onOpenChange={(o) => { if (!hardResetting) setHardResetOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" /> Reset Total do App
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Esta ação vai <strong>apagar permanentemente {queueCount} item(ns)</strong> da fila
                  de sincronização, limpar caches e recarregar o app.
                </p>
                <p className="text-destructive font-medium">
                  ⚠️ Fotos que ainda não subiram para o servidor serão perdidas e o promotor
                  precisará tirar novamente.
                </p>
                <p>Use somente quando a fila estiver travada e não subir mesmo online.</p>
                <p className="pt-2">Digite <strong>RESETAR</strong> para confirmar:</p>
                <Input
                  autoFocus
                  value={hardResetConfirmText}
                  onChange={(e) => setHardResetConfirmText(e.target.value)}
                  placeholder="RESETAR"
                  disabled={hardResetting}
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-col">
            <AlertDialogCancel className="w-full mt-0" disabled={hardResetting}>Cancelar</AlertDialogCancel>
            <Button
              onClick={doHardReset}
              disabled={hardResetting || hardResetConfirmText.trim().toUpperCase() !== 'RESETAR'}
              variant="destructive"
              className="w-full"
            >
              {hardResetting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
              {hardResetting ? 'Resetando...' : 'Apagar fila e resetar'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PromotorLayout>
  );
}
