import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Clock, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

interface CheckinWindowConfig {
  enabled: boolean;
  tolerance_minutes: number;
}

const DEFAULTS: CheckinWindowConfig = { enabled: true, tolerance_minutes: 15 };

/**
 * Configuração da janela de horário do check-in (por organização).
 *
 * A regra "o check-in só abre a partir do horário agendado da rota" é uma
 * política do cliente. Quem tem muitas rotas sem horário definido precisa
 * poder desligá-la sem editar rota por rota.
 */
export function CheckinWindowConfigPanel() {
  const [config, setConfig] = useState<CheckinWindowConfig>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ config: CheckinWindowConfig }>("/api/merch/checkin-window-config")
      .then((res) => {
        if (res?.config) {
          setConfig({
            enabled: res.config.enabled !== false,
            tolerance_minutes: Number(res.config.tolerance_minutes ?? DEFAULTS.tolerance_minutes),
          });
        }
      })
      .catch(() => { /* mantém o padrão */ })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api("/api/merch/checkin-window-config", { method: "PUT", body: config });
      toast.success("Configuração da janela de check-in salva!");
    } catch {
      toast.error("Erro ao salvar configuração");
    } finally {
      setSaving(false);
    }
  };

  const update = <K extends keyof CheckinWindowConfig>(key: K, val: CheckinWindowConfig[K]) =>
    setConfig((prev) => ({ ...prev, [key]: val }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          Janela de horário do check-in
        </CardTitle>
        <CardDescription>
          Define se o check-in do promotor só é permitido dentro do horário agendado da rota.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-1">
            <Label htmlFor="checkin-window-enabled" className="text-sm font-medium">
              Bloquear check-in fora do horário da rota
            </Label>
            <p className="text-xs text-muted-foreground">
              {config.enabled
                ? "Ativado: o app avisa o promotor antes da foto quando ele está fora da janela."
                : "Desativado: o check-in é liberado em qualquer horário (ideal para rotas sem horário definido)."}
            </p>
          </div>
          <Switch
            id="checkin-window-enabled"
            checked={config.enabled}
            onCheckedChange={(v) => update("enabled", v)}
            disabled={loading}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="checkin-window-tolerance" className="text-xs">
            Tolerância (minutos antes do horário da rota)
          </Label>
          <Input
            id="checkin-window-tolerance"
            type="number"
            min={0}
            max={240}
            value={config.tolerance_minutes}
            onChange={(e) => update("tolerance_minutes", Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
            disabled={loading || !config.enabled}
          />
          <p className="text-xs text-muted-foreground">
            Com tolerância de {config.tolerance_minutes} min, o check-in abre às {config.tolerance_minutes} min
            antes do horário agendado.
          </p>
        </div>

        <div className="flex gap-2 pt-2">
          <Button size="sm" onClick={handleSave} disabled={saving || loading} className="gap-1 ml-auto">
            <Save className="h-3 w-3" /> {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
