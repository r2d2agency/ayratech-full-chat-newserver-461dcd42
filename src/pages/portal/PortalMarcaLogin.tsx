import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, KeyRound, ShieldCheck } from "lucide-react";
import { authApi, setAuthToken, clearAuthToken } from "@/lib/api";
import { toast } from "sonner";

export default function PortalMarcaLogin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const brandName = params.get("n") || "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res: any = await authApi.login(email.trim().toLowerCase(), password);
      if (res?.token) setAuthToken(res.token);
      const me: any = await authApi.getMe();
      if (!me?.user?.brand_id) {
        clearAuthToken();
        toast.error("Este acesso não pertence a nenhuma marca. Fale com o seu gestor.");
        return;
      }
      window.location.href = "/marca/dashboard";
    } catch (err: any) {
      toast.error(err?.message || "E-mail ou chave de acesso inválidos");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-primary/10 p-4">
      <Card className="w-full max-w-md border-primary/20 shadow-xl">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">Portal do Cliente</CardTitle>
          <CardDescription>
            {brandName ? `Acesso exclusivo — ${brandName}` : "Acesso exclusivo para marcas parceiras"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="cliente@marca.com" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Chave de acesso</Label>
              <Input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <KeyRound className="h-4 w-4 mr-2" />}
              Entrar no meu dashboard
            </Button>
          </form>
          <p className="text-[11px] text-muted-foreground text-center mt-4">
            Você verá apenas os dados e indicadores da sua marca.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
