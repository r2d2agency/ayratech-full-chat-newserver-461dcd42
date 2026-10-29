import { useState, useMemo } from "react";
import { SupervisorLayout } from "./SupervisorLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, MapPin, User, Route as RouteIcon } from "lucide-react";
import { useSupervisorRoutes } from "@/hooks/use-supervisor";
import { useSupervisorTeam } from "@/hooks/use-promotor";

export default function SupervisorMapa() {
  const { data: team = [] } = useSupervisorTeam();
  const [promoterId, setPromoterId] = useState<string>("");

  const { data: routes = [], isLoading } = useSupervisorRoutes({
    promoter_id: promoterId && promoterId !== "all" ? promoterId : undefined,
  });

  const pdvs = useMemo(() => {
    const map = new Map<string, any>();
    (routes as any[]).forEach((r) => {
      const key = r.pdv_id || r.pdv_name;
      if (!map.has(key)) {
        map.set(key, {
          pdv_id: r.pdv_id,
          pdv_name: r.pdv_name,
          pdv_city: r.pdv_city,
          latitude: r.pdv_latitude,
          longitude: r.pdv_longitude,
          promoters: new Set<string>(),
          routes: [],
        });
      }
      const entry = map.get(key);
      if (r.promoter_name) entry.promoters.add(r.promoter_name);
      entry.routes.push(r);
    });
    return Array.from(map.values()).map((e) => ({
      ...e,
      promoters: Array.from(e.promoters),
    }));
  }, [routes]);

  return (
    <SupervisorLayout>
      <div className="p-4 max-w-lg mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">Mapa dos PDVs</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          PDVs com rotas atribuídas aos seus liderados
        </p>

        <Select value={promoterId} onValueChange={setPromoterId}>
          <SelectTrigger>
            <SelectValue placeholder="Todos os promotores" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {(team as any[]).map((p: any) => (
              <SelectItem key={p.id} value={p.id}>
                {p.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isLoading && <Loader2 className="h-6 w-6 animate-spin mx-auto" />}

        <div className="space-y-2">
          {pdvs.map((p) => (
            <Card key={p.pdv_id || p.pdv_name}>
              <CardContent className="p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-primary" />
                    <span className="font-medium text-sm">{p.pdv_name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <RouteIcon className="h-3 w-3" />
                    {p.routes.length} rota{p.routes.length !== 1 ? "s" : ""}
                  </span>
                </div>
                {p.pdv_city && (
                  <p className="text-xs text-muted-foreground">{p.pdv_city}</p>
                )}
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <User className="h-3 w-3 mt-0.5" />
                  <span>
                    {p.promoters.length > 0
                      ? p.promoters.join(", ")
                      : "Sem promotor atribuído"}
                  </span>
                </div>
                {(p.latitude && p.longitude) && (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary hover:underline inline-block"
                  >
                    Abrir no Google Maps
                  </a>
                )}
              </CardContent>
            </Card>
          ))}
          {pdvs.length === 0 && !isLoading && (
            <p className="text-sm text-muted-foreground text-center py-8">
              Nenhum PDV com rota atribuída
            </p>
          )}
        </div>
      </div>
    </SupervisorLayout>
  );
}
