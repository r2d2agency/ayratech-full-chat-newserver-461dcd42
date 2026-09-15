import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Camera, Save, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

interface PhotoQualityConfig {
  blur_tolerance: number;
  min_brightness: number;
  max_brightness: number;
  min_resolution_w: number;
  min_resolution_h: number;
  compression_quality: number;
  max_file_size_kb: number;
}

const DEFAULTS: PhotoQualityConfig = {
  blur_tolerance: 30,
  min_brightness: 40,
  max_brightness: 220,
  min_resolution_w: 640,
  min_resolution_h: 480,
  compression_quality: 0.7,
  max_file_size_kb: 1024,
};

export function PhotoQualityConfigPanel() {
  const [config, setConfig] = useState<PhotoQualityConfig>(DEFAULTS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // A rota fica montada em /api/merch (merch-routes.js), não
    // /api/merchandising — o painel apontava para um endpoint que não
    // existe, então as alterações nunca eram salvas nem carregadas (o GET
    // falhava silenciosamente e sempre mostrava os valores padrão).
    api<{ config: PhotoQualityConfig }>("/api/merch/photo-quality-config")
      .then((res) => { if (res?.config) setConfig(res.config); })
      .catch(() => { /* use defaults */ });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api("/api/merch/photo-quality-config", { method: "PUT", body: config });
      toast.success("Configuração de qualidade de foto salva!");
    } catch {
      toast.error("Erro ao salvar configuração");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => setConfig(DEFAULTS);

  const update = (key: keyof PhotoQualityConfig, val: number) =>
    setConfig((prev) => ({ ...prev, [key]: val }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Camera className="h-4 w-4 text-primary" />
          Qualidade de Foto — Configuração
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Blur tolerance */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium">Tolerância de borrado</Label>
            <span className="text-xs font-mono text-muted-foreground">{config.blur_tolerance}</span>
          </div>
          <Slider
            min={5} max={100} step={5}
            value={[config.blur_tolerance]}
            onValueChange={([v]) => update("blur_tolerance", v)}
          />
          <p className="text-[10px] text-muted-foreground">Menor = mais rigoroso. Padrão: 30</p>
        </div>

        {/* Brightness range */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">Brilho mínimo</Label>
            <Input
              type="number" min={0} max={255}
              value={config.min_brightness}
              onChange={(e) => update("min_brightness", +e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Brilho máximo</Label>
            <Input
              type="number" min={0} max={255}
              value={config.max_brightness}
              onChange={(e) => update("max_brightness", +e.target.value)}
            />
          </div>
        </div>

        {/* Resolution */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">Largura mínima (px)</Label>
            <Input
              type="number" min={320}
              value={config.min_resolution_w}
              onChange={(e) => update("min_resolution_w", +e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Altura mínima (px)</Label>
            <Input
              type="number" min={240}
              value={config.min_resolution_h}
              onChange={(e) => update("min_resolution_h", +e.target.value)}
            />
          </div>
        </div>

        {/* Compression */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium">Taxa de compressão</Label>
            <span className="text-xs font-mono text-muted-foreground">{Math.round(config.compression_quality * 100)}%</span>
          </div>
          <Slider
            min={10} max={100} step={5}
            value={[Math.round(config.compression_quality * 100)]}
            onValueChange={([v]) => update("compression_quality", v / 100)}
          />
        </div>

        {/* Max file size */}
        <div className="space-y-1">
          <Label className="text-xs">Tamanho máximo do arquivo (KB)</Label>
          <Input
            type="number" min={100} max={10240}
            value={config.max_file_size_kb}
            onChange={(e) => update("max_file_size_kb", +e.target.value)}
          />
        </div>

        <div className="flex gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={handleReset} className="gap-1">
            <RotateCcw className="h-3 w-3" /> Restaurar Padrão
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1 ml-auto">
            <Save className="h-3 w-3" /> {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
