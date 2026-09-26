import { useState, useEffect } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Settings, Shield, Bell, Save, Sun, Moon, Monitor, Volume2, VolumeX, BellRing, Smartphone, User, Lock, Loader2, Mail, FileText, Sparkles, Palette } from "lucide-react";
import { useTheme, Theme } from "@/hooks/use-theme";
import { useNotificationSound, NOTIFICATION_SOUNDS, NotificationSoundId } from "@/hooks/use-notification-sound";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isPWAInstalled } from "@/lib/pwa";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { SMTPConfigPanel } from "@/components/email/SMTPConfigPanel";
import { EmailTemplatesPanel } from "@/components/email/EmailTemplatesPanel";
import { FeaturesDocumentation } from "@/components/admin/FeaturesDocumentation";
import { AIConfigPanel } from "@/components/settings/AIConfigPanel";
import { PushNotificationSettings } from "@/components/settings/PushNotificationSettings";
import { NotificationConnectionSettings } from "@/components/settings/NotificationConnectionSettings";
import { ThemeCustomizer } from "@/components/admin/ThemeCustomizer";
import { GoogleCalendarPanel } from "@/components/crm/GoogleCalendarPanel";
import { api as apiCall } from "@/lib/api";
import { PhotoQualityConfigPanel } from "@/components/admin/PhotoQualityConfigPanel";
import { applyThemeColors } from "@/hooks/use-branding";

const Configuracoes = () => {
  const { user, refreshUser } = useAuth();


  const { theme, setTheme } = useTheme();
  const {
    settings: notifSettings,
    updateSettings: updateNotifSettings,
    pushPermission,
    requestPushPermission,
    previewSound,
    isPushSupported,
  } = useNotificationSound();

  const isAdminOrOwner = user?.role === 'owner' || user?.role === 'admin';
  const [orgThemePreset, setOrgThemePreset] = useState<string | null>(null);
  const [orgThemeCustom, setOrgThemeCustom] = useState<string | null>(null);
  const [orgFooterText, setOrgFooterText] = useState<string>("");
  const [isSavingFooter, setIsSavingFooter] = useState(false);



  // Load org theme on mount
  useEffect(() => {
    if (isAdminOrOwner && user?.organization_id) {
      apiCall<{ theme_preset: string | null; theme_custom_colors: string | null; footer_text: string | null }>(
        `/api/organizations/${user.organization_id}/theme`
      ).then(data => {
        setOrgThemePreset(data.theme_preset);
        setOrgThemeCustom(data.theme_custom_colors);
        setOrgFooterText(data.footer_text || "");
      }).catch(() => {});
    }

  }, [user?.organization_id, isAdminOrOwner]);

  const [displayName, setDisplayName] = useState(user?.name || "");
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);

  // Password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);

  const handleUpdateProfile = async () => {
    const trimmedName = displayName.trim();
    if (!trimmedName || trimmedName.length < 2) {
      toast.error("Nome deve ter pelo menos 2 caracteres");
      return;
    }
    
    setIsUpdatingProfile(true);
    try {
      await api("/api/auth/profile", { method: "PUT", body: { name: trimmedName } });
      toast.success("Nome atualizado com sucesso! Faça login novamente para ver as mudanças.");
    } catch (error: any) {
      toast.error(error.message || "Erro ao atualizar perfil");
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  const handleUpdatePassword = async () => {
    if (!currentPassword || !newPassword) {
      toast.error("Preencha todos os campos de senha");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("Nova senha deve ter pelo menos 6 caracteres");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("As senhas não conferem");
      return;
    }
    
    setIsUpdatingPassword(true);
    try {
      await api("/api/auth/password", { method: "PUT", body: { currentPassword, newPassword } });
      toast.success("Senha alterada com sucesso!");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error: any) {
      toast.error(error.message || "Erro ao alterar senha");
    } finally {
      setIsUpdatingPassword(false);
    }
  };

  const handleRequestPush = async () => {
    const granted = await requestPushPermission();
    if (granted) {
      toast.success("Notificações push ativadas!");
    } else {
      toast.error("Permissão negada. Ative nas configurações do navegador.");
    }
  };

  return (
    <MainLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="animate-slide-up">
          <h1 className="text-3xl font-bold text-foreground">Configurações</h1>
          <p className="mt-1 text-muted-foreground">
            Gerencie as configurações do sistema
          </p>
        </div>

        <Tabs defaultValue="geral" className="w-full">
          <TabsList className={cn("grid w-full", isAdminOrOwner ? "grid-cols-5 lg:w-[750px]" : "grid-cols-4 lg:w-[600px]")}>
            <TabsTrigger value="geral" className="flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Geral
            </TabsTrigger>
            {isAdminOrOwner && (
              <TabsTrigger value="aparencia" className="flex items-center gap-2">
                <Palette className="h-4 w-4" />
                Aparência
              </TabsTrigger>
            )}
            <TabsTrigger value="ia" className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              IA
            </TabsTrigger>
            <TabsTrigger value="email" className="flex items-center gap-2">
              <Mail className="h-4 w-4" />
              E-mail
            </TabsTrigger>
            <TabsTrigger value="docs" className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Recursos
            </TabsTrigger>
          </TabsList>

          {/* Org Appearance Settings (moved or additional section) */}
          {isAdminOrOwner && (
            <TabsContent value="aparencia" className="mt-6 space-y-6">
              <ThemeCustomizer
                currentPreset={orgThemePreset}
                currentCustomColors={orgThemeCustom}
                onSave={async (preset, customColors) => {
                  if (!user?.organization_id) return;
                  await api(`/api/organizations/${user.organization_id}/theme`, {
                    method: 'PATCH',
                    body: { theme_preset: preset, theme_custom_colors: customColors }
                  });
                  setOrgThemePreset(preset);
                  setOrgThemeCustom(customColors);
                  applyThemeColors(preset, customColors);
                }}
              />

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    Texto do Rodapé
                  </CardTitle>
                  <CardDescription>Texto personalizado que aparece no rodapé do sistema</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="footerText">Texto customizado</Label>
                    <Input 
                      id="footerText" 
                      value={orgFooterText} 
                      onChange={e => setOrgFooterText(e.target.value)} 
                      placeholder="Ex: Agência XYZ - Todos os direitos reservados"
                    />
                  </div>
                  <Button 
                    className="w-full" 
                    disabled={isSavingFooter}
                    onClick={async () => {
                      if (!user?.organization_id) return;
                      setIsSavingFooter(true);
                      try {
                        await api(`/api/organizations/${user.organization_id}`, {
                          method: 'PATCH',
                          body: { footer_text: orgFooterText }
                        });
                        await refreshUser();
                        toast.success("Rodapé atualizado!");

                      } finally {
                        setIsSavingFooter(false);
                      }
                    }}
                  >
                    {isSavingFooter ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                    Salvar Rodapé
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>
          )}


          {/* General Settings Tab */}
          <TabsContent value="geral" className="mt-6">
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Photo Quality Config for admin */}
              {isAdminOrOwner && (
                <div className="lg:col-span-2">
                  <PhotoQualityConfigPanel />
                </div>
              )}
              {/* Profile Settings */}
              <Card className="animate-fade-in shadow-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <User className="h-5 w-5 text-primary" />
                    Perfil
                  </CardTitle>
                  <CardDescription>
                    Seu nome de exibição no sistema
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="displayName">Nome de exibição</Label>
                    <Input
                      id="displayName"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Seu nome"
                      maxLength={100}
                    />
                    <p className="text-xs text-muted-foreground">
                      Este nome aparece nas mensagens enviadas e na assinatura
                    </p>
                  </div>
                  <Button
                    onClick={handleUpdateProfile}
                    disabled={isUpdatingProfile || displayName.trim() === user?.name}
                    className="w-full"
                  >
                    {isUpdatingProfile ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Salvando...
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4 mr-2" />
                        Salvar Nome
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>

              {/* Password Settings */}
              <Card className="animate-fade-in shadow-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Lock className="h-5 w-5 text-primary" />
                    Alterar Senha
                  </CardTitle>
                  <CardDescription>
                    Atualize sua senha de acesso
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="currentPassword">Senha atual</Label>
                    <Input
                      id="currentPassword"
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="••••••••"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newPassword">Nova senha</Label>
                    <Input
                      id="newPassword"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="••••••••"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirmar nova senha</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="••••••••"
                    />
                  </div>
                  <Button
                    onClick={handleUpdatePassword}
                    disabled={isUpdatingPassword || !currentPassword || !newPassword}
                    className="w-full"
                  >
                    {isUpdatingPassword ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Alterando...
                      </>
                    ) : (
                      <>
                        <Lock className="h-4 w-4 mr-2" />
                        Alterar Senha
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>

              {/* Appearance Settings */}
              <Card className="animate-fade-in shadow-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sun className="h-5 w-5 text-primary" />
                    Aparência
                  </CardTitle>
                  <CardDescription>
                    Escolha o tema do sistema
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <RadioGroup
                    value={theme}
                    onValueChange={(value) => setTheme(value as Theme)}
                    className="grid gap-3"
                  >
                    <div className="flex items-center space-x-3 rounded-lg border border-border p-4 hover:bg-accent/50 transition-colors cursor-pointer">
                      <RadioGroupItem value="light" id="light" />
                      <Label htmlFor="light" className="flex items-center gap-3 cursor-pointer flex-1">
                        <div className="p-2 rounded-full bg-amber-100 dark:bg-amber-900/30">
                          <Sun className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div>
                          <p className="font-medium">Modo Claro</p>
                          <p className="text-sm text-muted-foreground">
                            Interface clara e luminosa
                          </p>
                        </div>
                      </Label>
                    </div>
                    
                    <div className="flex items-center space-x-3 rounded-lg border border-border p-4 hover:bg-accent/50 transition-colors cursor-pointer">
                      <RadioGroupItem value="dark" id="dark" />
                      <Label htmlFor="dark" className="flex items-center gap-3 cursor-pointer flex-1">
                        <div className="p-2 rounded-full bg-indigo-100 dark:bg-indigo-900/30">
                          <Moon className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                        </div>
                        <div>
                          <p className="font-medium">Modo Escuro</p>
                          <p className="text-sm text-muted-foreground">
                            Interface escura, ideal para ambientes com pouca luz
                          </p>
                        </div>
                      </Label>
                    </div>
                    
                    <div className="flex items-center space-x-3 rounded-lg border border-border p-4 hover:bg-accent/50 transition-colors cursor-pointer">
                      <RadioGroupItem value="system" id="system" />
                      <Label htmlFor="system" className="flex items-center gap-3 cursor-pointer flex-1">
                        <div className="p-2 rounded-full bg-slate-100 dark:bg-slate-800">
                          <Monitor className="h-4 w-4 text-slate-600 dark:text-slate-400" />
                        </div>
                        <div>
                          <p className="font-medium">Automático</p>
                          <p className="text-sm text-muted-foreground">
                            Segue a preferência do sistema operacional
                          </p>
                        </div>
                      </Label>
                    </div>
                  </RadioGroup>
                </CardContent>
              </Card>

              {/* Sound Notification Settings */}
              <Card className="animate-fade-in shadow-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Volume2 className="h-5 w-5 text-primary" />
                    Som de Notificação
                  </CardTitle>
                  <CardDescription>
                    Escolha o som para novas mensagens
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Sound enabled toggle */}
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="flex items-center gap-2">
                        {notifSettings.soundEnabled ? (
                          <Volume2 className="h-4 w-4" />
                        ) : (
                          <VolumeX className="h-4 w-4" />
                        )}
                        Sons ativados
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Tocar som ao receber mensagens
                      </p>
                    </div>
                    <Switch
                      checked={notifSettings.soundEnabled}
                      onCheckedChange={(checked) => updateNotifSettings({ soundEnabled: checked })}
                    />
                  </div>

                  {/* Sound selection */}
                  {notifSettings.soundEnabled && (
                    <>
                      <div className="space-y-3">
                        <Label>Escolha o som</Label>
                        <RadioGroup
                          value={notifSettings.soundId}
                          onValueChange={(value) => {
                            updateNotifSettings({ soundId: value as NotificationSoundId });
                            if (value !== 'none') {
                              previewSound(value as NotificationSoundId);
                            }
                          }}
                          className="grid gap-2"
                        >
                          {NOTIFICATION_SOUNDS.map((sound) => (
                            <div
                              key={sound.id}
                              className="flex items-center space-x-3 rounded-lg border border-border p-3 hover:bg-accent/50 transition-colors cursor-pointer"
                            >
                              <RadioGroupItem value={sound.id} id={`sound-${sound.id}`} />
                              <Label htmlFor={`sound-${sound.id}`} className="cursor-pointer flex-1">
                                {sound.name}
                              </Label>
                              {sound.file && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    previewSound(sound.id);
                                  }}
                                >
                                  <Volume2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          ))}
                        </RadioGroup>
                      </div>

                      {/* Volume slider */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label>Volume</Label>
                          <span className="text-sm text-muted-foreground">
                            {Math.round(notifSettings.volume * 100)}%
                          </span>
                        </div>
                        <Slider
                          value={[notifSettings.volume]}
                          onValueChange={([value]) => updateNotifSettings({ volume: value })}
                          max={1}
                          step={0.1}
                          className="w-full"
                        />
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Per-device and per-connection notification settings */}
              <NotificationConnectionSettings />

              {/* Web Push Notifications */}
              <PushNotificationSettings />

              {/* PWA Install */}
              <Card className="animate-fade-in shadow-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Smartphone className="h-5 w-5 text-primary" />
                    Instalar App
                  </CardTitle>
                  <CardDescription>
                    Adicione o Glee-go Whats à tela inicial do seu celular
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-lg bg-accent/50 p-4 space-y-3">
                    <p className="text-sm">
                      Para instalar o app no seu celular:
                    </p>
                    <div className="space-y-2 text-sm text-muted-foreground">
                      <p><strong>iPhone/iPad:</strong> Toque no botão compartilhar (📤) e selecione "Adicionar à Tela de Início"</p>
                      <p><strong>Android:</strong> Toque no menu (⋮) do navegador e selecione "Instalar app" ou "Adicionar à tela inicial"</p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      const deferredPrompt = (window as any).deferredPrompt;
                      if (deferredPrompt) {
                        deferredPrompt.prompt();
                        deferredPrompt.userChoice.then((choice: any) => {
                          if (choice.outcome === 'accepted') {
                            toast.success('App instalado com sucesso!');
                          }
                          (window as any).deferredPrompt = null;
                        });
                      } else {
                         const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent);
                         if (isIOSDevice) {
                           toast.info('No Safari, toque em 📤 (Compartilhar) e depois em "Adicionar à Tela de Início"');
                         } else {
                           toast.info('No menu do navegador (⋮), toque em "Instalar app" ou "Adicionar à tela inicial"');
                         }
                      }
                    }}
                  >
                    <Smartphone className="h-4 w-4 mr-2" />
                    Instalar Glee-go Whats
                  </Button>
                  {isPWAInstalled() && (
                    <p className="text-sm text-green-600 font-medium text-center">✅ App já está instalado!</p>
                  )}
                </CardContent>
              </Card>

              {/* General Settings */}
              <Card className="animate-fade-in shadow-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Settings className="h-5 w-5 text-primary" />
                    Configurações Gerais
                  </CardTitle>
                  <CardDescription>
                    Ajustes básicos do sistema
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Auto-refresh</Label>
                      <p className="text-sm text-muted-foreground">
                        Atualizar dados automaticamente
                      </p>
                    </div>
                    <Switch defaultChecked />
                  </div>
                </CardContent>
              </Card>

              {/* Security Settings */}
              <Card className="animate-fade-in shadow-card">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Shield className="h-5 w-5 text-primary" />
                    Segurança do WhatsApp
                  </CardTitle>
                  <CardDescription>
                    Proteções para evitar bloqueio da sua conta
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="maxMessagesDay">Limite diário de mensagens</Label>
                      <Input
                        id="maxMessagesDay"
                        type="number"
                        defaultValue="500"
                        placeholder="Ex: 500"
                      />
                      <p className="text-xs text-muted-foreground">
                        Máximo de mensagens por dia
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="minPause">Pausa mínima (seg)</Label>
                        <Input
                          id="minPause"
                          type="number"
                          defaultValue="30"
                          placeholder="Ex: 30"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="maxPause">Pausa máxima (seg)</Label>
                        <Input
                          id="maxPause"
                          type="number"
                          defaultValue="120"
                          placeholder="Ex: 120"
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Google Calendar - conexão pessoal */}
            <div className="mt-6">
              <GoogleCalendarPanel />
            </div>

            <div className="flex justify-end mt-6">
              <Button variant="gradient" size="lg">
                <Save className="h-4 w-4" />
                Salvar Todas as Configurações
              </Button>
            </div>
          </TabsContent>

          {/* Appearance Tab */}
          {isAdminOrOwner && (
            <TabsContent value="aparencia" className="mt-6">
              <div className="space-y-4">
                <div>
                  <h2 className="text-xl font-semibold">Aparência</h2>
                  <p className="text-sm text-muted-foreground">
                    Personalize as cores do sistema para a sua empresa
                  </p>
                </div>
                <ThemeCustomizer
                  currentPreset={orgThemePreset}
                  currentCustomColors={orgThemeCustom}
                  onSave={async (preset, customColors) => {
                    if (!user?.organization_id) return;
                    await apiCall(`/api/organizations/${user.organization_id}/theme`, {
                      method: 'PATCH',
                      body: { theme_preset: preset, theme_custom_colors: customColors },
                    });
                    setOrgThemePreset(preset);
                    setOrgThemeCustom(customColors);
                  }}
                />
              </div>
            </TabsContent>
          )}


          <TabsContent value="ia" className="mt-6 space-y-6">
            <AIConfigPanel />
          </TabsContent>

          {/* Email Settings Tab */}
          <TabsContent value="email" className="mt-6 space-y-6">
            <SMTPConfigPanel />
            <EmailTemplatesPanel />
          </TabsContent>

          {/* Features Documentation Tab */}
          <TabsContent value="docs" className="mt-6">
            <FeaturesDocumentation />
          </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
};

export default Configuracoes;
