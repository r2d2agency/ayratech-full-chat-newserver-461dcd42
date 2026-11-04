import { useMemo, useState, useEffect, useRef } from 'react';
import { SupervisorLayout } from './SupervisorLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, MapPin, Navigation, Clock, User, Store, Users, Route } from 'lucide-react';
import { useSupervisorRoutes } from '@/hooks/use-supervisor';
import { useSupervisorTeam } from '@/hooks/use-supervisor';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-green-500/20 text-green-700',
  offline: 'bg-gray-400/20 text-gray-600',
};

function isRecent(ts: any) {
  if (!ts) return false;
  const d = new Date(ts);
  return !isNaN(d.getTime()) && (Date.now() - d.getTime()) < 15 * 60 * 1000;
}

const createPromoterIcon = (online: boolean) =>
  L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      background-color: ${online ? '#22c55e' : '#9ca3af'};
      width: 28px;
      height: 28px;
      border-radius: 50% 50% 50% 0;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      transform: rotate(-45deg);
      display: flex;
      align-items: center;
      justify-content: center;
    "><div style="width: 10px; height: 10px; background: white; border-radius: 50%; transform: rotate(45deg);"></div></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28],
  });

function PromoterMap({ team }: { team: any[] }) {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<L.Marker[]>([]);

  const promotersWithLoc = useMemo(
    () => team.filter((p: any) => p.last_latitude && p.last_longitude),
    [team]
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    mapRef.current = L.map(containerRef.current).setView(promotersWithLoc.length ? [Number(promotersWithLoc[0].last_latitude), Number(promotersWithLoc[0].last_longitude)] : [-14.235, -51.9253], promotersWithLoc.length ? 12 : 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
    }).addTo(mapRef.current);
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    promotersWithLoc.forEach((p: any) => {
      const recent = p.last_location_at ? (Date.now() - new Date(p.last_location_at).getTime()) < 15 * 60 * 1000 : false;
      const online = p.live_status === 'online' || recent;
      const icon = createPromoterIcon(online);
      const marker = L.marker([Number(p.last_latitude), Number(p.last_longitude)], { icon }).addTo(mapRef.current!);
      const popup = `
        <div style="min-width: 180px;">
          <p style="font-weight: 600; margin: 0;">${p.full_name}</p>
          <p style="font-size: 12px; color: #666; margin: 2px 0;">${p.position || 'Promotor'}</p>
          <p style="font-size: 12px; margin: 4px 0;">${online ? '🟢 Online' : '⚪ Offline'}</p>
          ${p.last_pdv_name ? `<p style="font-size: 12px; color: #666; margin: 2px 0;">Último PDV: ${p.last_pdv_name}</p>` : ''}
          ${p.last_location_at ? `<p style="font-size: 11px; color: #888; margin: 2px 0;">${new Date(p.last_location_at).toLocaleString('pt-BR')}</p>` : ''}
        </div>
      `;
      marker.bindPopup(popup);
      markersRef.current.push(marker);
    });

    if (promotersWithLoc.length > 0) {
      const group = L.featureGroup(markersRef.current);
      mapRef.current.fitBounds(group.getBounds().pad(0.2));
    }
  }, [promotersWithLoc]);

  return <div ref={containerRef} className="w-full h-[400px] rounded-lg overflow-hidden" />;
}

export default function SupervisorMapa() {
  const { data: team = [], isLoading: loadingTeam } = useSupervisorTeam();
  const { data: routes = [], isLoading: loadingRoutes } = useSupervisorRoutes({});
  const [tab, setTab] = useState<'pdvs' | 'location' | 'map'>('pdvs');
  const [filterPromoter, setFilterPromoter] = useState('all');

  // PDVs agrupados por promotor
  const pdvsByPromoter = useMemo(() => {
    const map: Record<string, { promoter: any; pdvs: any[] }> = {};
    (team as any[]).forEach((p: any) => {
      map[p.id] = { promoter: p, pdvs: [] };
    });
    const seen = new Set<string>();
    (routes as any[]).forEach((r: any) => {
      const key = r.promoter_id;
      if (!map[key]) map[key] = { promoter: { id: key, full_name: r.promoter_name }, pdvs: [] };
      const pdvKey = `${key}:${r.pdv_id}`;
      if (seen.has(pdvKey)) return;
      seen.add(pdvKey);
      map[key].pdvs.push({
        id: r.pdv_id,
        name: r.pdv_name,
        city: r.pdv_city,
        address: r.pdv_address,
        latitude: r.pdv_latitude,
        longitude: r.pdv_longitude,
        scheduled_time: r.scheduled_time,
        visit_date: r.visit_date,
      });
    });
    return Object.values(map).filter((g: any) => filterPromoter === 'all' || g.promoter?.id === filterPromoter);
  }, [team, routes, filterPromoter]);

  const filteredTeam = useMemo(() => {
    return (team as any[]).filter((p: any) => filterPromoter === 'all' || p.id === filterPromoter);
  }, [team, filterPromoter]);

  return (
    <SupervisorLayout>
      <div className="p-4 max-w-lg mx-auto space-y-4">
        <h1 className="text-lg font-bold flex items-center gap-2">
          <MapPin className="h-5 w-5" /> Mapa de PDVs e Equipe
        </h1>

        <div className="flex gap-2">
          <Button variant={tab === 'pdvs' ? 'default' : 'outline'} size="sm" onClick={() => setTab('pdvs')} className="flex-1">
            <Store className="h-4 w-4 mr-1" /> PDVs por promotor
          </Button>
          <Button variant={tab === 'map' ? 'default' : 'outline'} size="sm" onClick={() => setTab('map')} className="flex-1">
            <MapPin className="h-4 w-4 mr-1" /> Mapa
          </Button>
          <Button variant={tab === 'location' ? 'default' : 'outline'} size="sm" onClick={() => setTab('location')} className="flex-1">
            <Navigation className="h-4 w-4 mr-1" /> Lista
          </Button>
        </div>

        <Select value={filterPromoter} onValueChange={setFilterPromoter}>
          <SelectTrigger><SelectValue placeholder="Promotor" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {(team as any[]).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}
          </SelectContent>
        </Select>

        {loadingTeam || loadingRoutes ? (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : tab === 'pdvs' ? (
          <div className="space-y-3">
            {pdvsByPromoter.map((g: any) => (
              <Card key={g.promoter?.id}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                      {g.promoter?.full_name?.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{g.promoter?.full_name}</p>
                      <p className="text-xs text-muted-foreground">{g.pdvs.length} PDV(s)</p>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {g.pdvs.length === 0 && <p className="text-xs text-muted-foreground italic">Sem PDVs atribuídos</p>}
                    {g.pdvs.map((p: any) => (
                      <div key={p.id} className="flex items-center justify-between text-xs p-2 bg-muted/30 rounded-lg gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{p.name}</p>
                          <p className="text-muted-foreground truncate">{p.city}{p.address ? ` • ${p.address}` : ''}</p>
                          {p.scheduled_time && (
                            <p className="text-muted-foreground flex items-center gap-1">
                              <Clock className="h-3 w-3" /> {String(p.scheduled_time).slice(0, 5)} • {String(p.visit_date).slice(0, 10)}
                            </p>
                          )}
                        </div>
                        {p.latitude && p.longitude && (
                          <a
                            href={`https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary flex-shrink-0"
                          >
                            <MapPin className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
            {pdvsByPromoter.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">Nenhum promotor</p>}
          </div>
        ) : tab === 'map' ? (
          <Card>
            <CardContent className="p-0">
              {(team as any[]).some((p: any) => p.last_latitude && p.last_longitude) ? (
                <PromoterMap team={team as any[]} />
              ) : (
                <div className="h-[400px] flex flex-col items-center justify-center text-muted-foreground">
                  <MapPin className="h-12 w-12 mb-4 opacity-30" />
                  <p className="text-sm">Nenhum promotor com localização recente</p>
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {filteredTeam.map((p: any) => {
              const recent = isRecent(p.last_location_at);
              const online = p.live_status === 'online' || recent;
              return (
                <Card key={p.id}>
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-sm font-bold text-primary">
                          {p.full_name?.charAt(0)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{p.full_name}</p>
                          <p className="text-xs text-muted-foreground">{p.position || 'Promotor'}</p>
                        </div>
                      </div>
                      <Badge className={online ? 'bg-green-500/20 text-green-700' : 'bg-gray-400/20 text-gray-600'}>
                        {online ? 'Online' : 'Offline'}
                      </Badge>
                    </div>
                    {p.last_pdv_name && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Store className="h-3 w-3" /> Último PDV: {p.last_pdv_name}
                      </p>
                    )}
                    {(p.today_routes_count ?? 0) > 0 && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {p.today_routes_count} rota(s) hoje
                      </p>
                    )}
                    {p.last_location_at && (
                      <p className="text-xs text-muted-foreground">
                        Atualizado: {new Date(p.last_location_at).toLocaleString('pt-BR')}
                      </p>
                    )}
                    {p.last_latitude && p.last_longitude ? (
                      <Button size="sm" variant="outline" className="w-full" asChild>
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${p.last_latitude},${p.last_longitude}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <MapPin className="h-4 w-4 mr-1" /> Abrir no Google Maps
                        </a>
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">Sem localização recente</p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
            {filteredTeam.length === 0 && <p className="text-sm text-muted-foreground text-center py-8">Nenhum promotor</p>}
          </div>
        )}
      </div>
    </SupervisorLayout>
  );
}
