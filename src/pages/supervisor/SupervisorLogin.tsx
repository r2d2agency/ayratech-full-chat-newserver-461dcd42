import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Smartphone, MapPin } from "lucide-react";
import { useBranding } from "@/hooks/use-branding";

export default function SupervisorLogin() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { branding } = useBranding() as any;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const apiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
      const res = await fetch(`${apiUrl}/api/supervisor/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro no login');

      localStorage.setItem('supervisor_token', data.token);
      localStorage.setItem('supervisor_employee', JSON.stringify(data.employee));

      if (data.employee.force_password_change) {
        navigate('/supervisor/trocar-senha');
      } else if (data.employee?.agency?.uses_merchandising === false || data.employee?.is_access_only) {
        navigate('/acesso/supervisor/home');
      } else {
        navigate('/supervisor/home');
      }
      toast({ title: 'Login realizado!' });
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/10 via-background to-accent/10 flex items-center justify-center p-4">
      <Card className="w-full max-w-sm shadow-xl">
        <CardHeader className="text-center space-y-3">
          {branding.logo && (
            <img src={branding.logo} alt="Logo" className="h-12 mx-auto object-contain" />
          )}
          <CardTitle className="text-xl font-bold">App do Colaborador</CardTitle>
          <p className="text-sm text-muted-foreground">Acesse com CPF ou e-mail</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label>CPF ou E-mail</Label>
              <Input
                value={login}
                onChange={e => setLogin(e.target.value)}
                placeholder="000.000.000-00 ou email@email.com"
                required
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label>Senha</Label>
              <Input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Smartphone className="h-4 w-4 mr-2" />}
              Entrar
            </Button>
          </form>
          <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span>Necessário GPS ativo para registro de ponto</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
