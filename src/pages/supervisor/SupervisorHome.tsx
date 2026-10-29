import { useNavigate } from 'react-router-dom';
import { SupervisorLayout } from './SupervisorLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Route, Calendar, Users, Clock, MapPin, FileText,
} from 'lucide-react';

const tiles = [
  { label: 'Rotas', icon: Route, path: '/supervisor/rotas', desc: 'Supervisionar e ajustar rotas' },
  { label: 'Agenda', icon: Calendar, path: '/supervisor/agenda', desc: 'Agenda dos liderados' },
  { label: 'Equipe', icon: Users, path: '/promotor/equipe', desc: 'Minha equipe' },
  { label: 'Ponto', icon: Clock, path: '/promotor/ponto', desc: 'Ponto dos liderados' },
];

export default function SupervisorHome() {
  const navigate = useNavigate();
  return (
    <SupervisorLayout>
      <div className="p-4 max-w-lg mx-auto space-y-4">
        <h1 className="text-lg font-bold">Painel de Supervisão</h1>
        <p className="text-sm text-muted-foreground">Administração de merchandising dos liderados</p>
        <div className="grid grid-cols-2 gap-3">
          {tiles.map((t) => (
            <Card key={t.path} className="cursor-pointer hover:border-primary/40" onClick={() => navigate(t.path)}>
              <CardContent className="p-4 flex flex-col gap-2">
                <t.icon className="h-6 w-6 text-primary" />
                <span className="font-medium text-sm">{t.label}</span>
                <span className="text-xs text-muted-foreground">{t.desc}</span>
              </CardContent>
            </Card>
          ))}
        </div>
        <Button variant="outline" className="w-full" onClick={() => navigate('/promotor/equipe')}>
          <Users className="h-4 w-4 mr-2" /> Ver equipe detalhada
        </Button>
      </div>
    </SupervisorLayout>
  );
}
