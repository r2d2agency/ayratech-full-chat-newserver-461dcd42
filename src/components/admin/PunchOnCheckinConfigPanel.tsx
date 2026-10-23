import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Fingerprint, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

interface PunchOnCheckinConfig {
  enabled: boolean;
}

const DEFAULTS: PunchOnCheckinConfig = { enabled: false };

/**
 * Controle de ponto pelo check-in (por organização).
 *
 * Quando ativo, a foto da fachada no check-in da loja já registra a ENTRADA no
 * relógio de ponto — o promotor não precisa abrir o ponto para bater entrada.
 * A saída do almoço e o retorno continuam manuais (botão), e a saída do dia
 * pode ser batida pelo app ou é fechada automaticamente no fim da jornada.
 */
export function PunchOnCheckinConfigPanel() {
  const [config, setConfig] = useState<PunchOnCheckinConfig>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ config: PunchOnCheckinConfig }>("/api/merch/punch-on-checkin-config")
      .then((res) => {
        if (res?.config) setConfig({ enabled: res.config.enabled === true });
      })
      .catch(() => { /* mantém o padrão desligado */ })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api("/api/merch/punch-on-checkin-config", { method: "PUT", body: config });
      toast.success("Configuração de controle de ponto salva!");
    } catch {
      toast.error("Erro ao salvar configuração");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-primary" />
          Controle de ponto pelo check-in
        </CardTitle>
        <CardDescription>
          Bate a entrada do ponto automaticamente quando o promotor faz o check-in na loja.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-1">
            <Label htmlFor="punch-on-checkin-enabled" className="text-sm font-medium">
              Usar o check-in como batida de entrada
            </Label>
            <p className="text-xs text-muted-foreground">
              {config.enabled
                ? "Ativado: após a foto da fachada o promotor vê o aviso de jornada iniciada e não precisa bater entrada no relógio. Almoço e saída continuam podendo ser batidos pelo app."
                : "Desativado: o promotor bate entrada e saída no relógio de ponto, como hoje."}
            </p>
          </div>
          <Switch
            id="punch-on-checkin-enabled"
            checked={config.enabled}
            onCheckedChange={(v) => setConfig({ enabled: v })}
            disabled={loading}
          />
        </div>

        <p className="text-xs text-muted-foreground">
          No fim da jornada, se o promotor não bater a saída, o sistema registra o ponto
          automaticamente: pelo checkout da loja, ou pela última foto registrada na rota
          quando o checkout não foi feito.
        </p>

        <div className="flex gap-2 pt-2">
          <Button size="sm" onClick={handleSave} disabled={saving || loading} className="gap-1 ml-auto">
            <Save className="h-3 w-3" /> {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
