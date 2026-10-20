import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export default function SemAcesso() {
  const { user, pagePermissions } = useAuth();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <ShieldAlert className="h-8 w-8 text-destructive" />
        </div>
        <h1 className="text-2xl font-semibold mb-2">Acesso não autorizado</h1>
        <p className="text-muted-foreground mb-6">
          O template de acesso atribuído a você não permite visualize esta página.
          Fale com o administrador da organização para solicitar acesso.
        </p>
        <div className="rounded-lg border bg-muted/40 p-4 text-left text-sm">
          <p className="font-medium mb-1">Sua conta</p>
          <p className="text-muted-foreground">{user?.name} — {user?.email}</p>
          <p className="text-muted-foreground mt-2">
            {pagePermissions
              ? 'Perfil restrito por template de acesso.'
              : 'Nenhum template de acesso aplicado.'}
          </p>
        </div>
        <Link
          to="/dashboard"
          className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Voltar ao início
        </Link>
      </div>
    </div>
  );
}
