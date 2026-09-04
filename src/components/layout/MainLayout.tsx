import { ReactNode } from "react";
import { Sidebar, SIDEBAR_COLLAPSED_WIDTH } from "./Sidebar";
import { TopBar } from "./TopBar";
import { MessageNotifications } from "./MessageNotifications";
import { CRMAlerts } from "./CRMAlerts";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";
import { GroupSecretaryPopup } from "./GroupSecretaryPopup";
import { PWAUpdateBanner } from "./PWAUpdateBanner";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { ShieldCheck, LogOut } from "lucide-react";

interface MainLayoutProps {
  children: ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const { user, logout } = useAuth();

  // Portal do Cliente (marca): shell limpo, sem nenhum item do sistema
  if (user?.brand_id) {
    return (
      <div className="min-h-screen bg-background">
        <header className="h-14 border-b border-border/60 flex items-center justify-between px-4 bg-card/50 backdrop-blur">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Portal do Cliente
          </div>
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut className="h-4 w-4 mr-1" /> Sair
          </Button>
        </header>
        <main className="p-3 xl:p-4">{children}</main>
        <footer className="py-4 px-4 border-t text-center space-y-1">
          {user?.organization_footer && (
            <p className="text-xs text-muted-foreground font-medium">{user.organization_footer}</p>
          )}
          <p className="text-[10px] text-muted-foreground/60 italic">
            Powered by Ayratech
          </p>
        </footer>
      </div>

    );
  }

  return (
    <div className="min-h-screen bg-background overflow-hidden">
      <Sidebar />
      <TopBar />
      
      {/* Mobile/Tablet TopBar with notifications */}
      <div className="xl:hidden fixed top-0 right-0 left-12 h-14 flex items-center justify-end gap-2 px-3 bg-background/95 backdrop-blur-sm border-b border-border/50 z-50"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <ConnectionStatusIndicator />
        <div className="h-5 w-px bg-border" />
        <MessageNotifications />
        <CRMAlerts />
      </div>
      
      {/* Desktop: margin-left for collapsed sidebar + top bar, Mobile/Tablet: no margin */}
      <main className="xl:ml-16 pt-14 xl:pt-12 overflow-x-hidden w-full xl:w-[calc(100vw-4rem)] box-border"
        style={{ paddingTop: 'max(3.5rem, calc(env(safe-area-inset-top, 0px) + 3.5rem))' }}>
        <div className="p-2 xl:p-3 2xl:p-4 w-full min-w-0 overflow-x-hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>{children}</div>
      </main>
      <footer className="xl:ml-16 py-4 px-4 border-t text-center space-y-1 bg-background/50">
        {user?.organization_footer && (
          <p className="text-xs text-muted-foreground font-medium">{user.organization_footer}</p>
        )}
        <p className="text-[10px] text-muted-foreground/60 italic">
          © {new Date().getFullYear()} Ayratech • Todos os direitos reservados
        </p>
        <p className="text-[10px] text-muted-foreground/40">TNS R2D2</p>
      </footer>
      <GroupSecretaryPopup />

      <PWAUpdateBanner />
    </div>
  );
}
