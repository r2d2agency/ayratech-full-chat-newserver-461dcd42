import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { authApi, setAuthToken, clearAuthToken, getAuthToken, AUTH_INVALID_EVENT } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';

interface ModulesEnabled {
  campaigns: boolean;
  billing: boolean;
  groups: boolean;
  scheduled_messages: boolean;
  chatbots: boolean;
  chat: boolean;
  crm: boolean;
  rh: boolean;
  ai_agents: boolean;
  group_secretary: boolean;
  ghost: boolean;
  projects: boolean;
  lead_gleego: boolean;
  doc_signatures: boolean;
}

// Page-level permissions from permission templates
export type PagePermissions = Record<string, boolean> | null;

interface User {
  id: string;
  email: string;
  name: string;
  role?: string;
  organization_id?: string;
  brand_id?: string;
  modules_enabled?: ModulesEnabled;
  organization_footer?: string | null;
  has_connections?: boolean;

  page_permissions?: PagePermissions;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  modulesEnabled: ModulesEnabled;
  pagePermissions: PagePermissions;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, planId?: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  const defaultModules: ModulesEnabled = {
    campaigns: true,
    billing: true,
    groups: true,
    scheduled_messages: true,
    chatbots: true,
    chat: true,
    crm: true,
    rh: true,
    ai_agents: true,
    group_secretary: false,
    ghost: true,
    projects: false,
    lead_gleego: false,
    doc_signatures: false,
  };

  const refreshUser = async () => {
    const token = getAuthToken();
    if (token) {
      try {
        const { user } = await authApi.getMe();
        setUser(user);
      } catch {
        clearAuthToken();
        sessionStorage.removeItem('user_org_id');
        setUser(null);
      }
    }
  };

  useEffect(() => {
    const checkAuth = async () => {
      const token = getAuthToken();
      if (token) {
        try {
          const { user: userData } = await authApi.getMe();
          const u = userData as any;
          setUser(u);
          if (u.organization_id) {
            sessionStorage.setItem('user_org_id', u.organization_id);
          }
        } catch {
          clearAuthToken();
        }
      }
      setIsLoading(false);
    };
    checkAuth();
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      // Only clear the main app token. Scoped tokens (promotor/agency/supermarket)
      // are managed by their own contexts and must NOT be cleared here, otherwise
      // a 401 on a main-app endpoint would log the promotor out mid-flow.
      clearAuthToken();
      sessionStorage.removeItem('user_org_id');
      setUser(null);
      setIsLoading(false);

      if (user) {
        toast({ title: 'Sessão expirada', description: 'Faça login novamente.', variant: 'destructive' });
      }
    };

    window.addEventListener(AUTH_INVALID_EVENT, handleUnauthorized);
    return () => window.removeEventListener(AUTH_INVALID_EVENT, handleUnauthorized);
  }, [toast, user]);

  const login = async (email: string, password: string) => {
    const startedAt = Date.now();
    await logger.info('login_started', {
      event_name: 'login_started',
      online: navigator.onLine,
      method: 'password',
    });
    try {
      const { user: userData, token } = await authApi.login(email, password);
    setAuthToken(token);
    const u = userData as any;
    setUser(u);
    if (u.organization_id) {
      sessionStorage.setItem('user_org_id', u.organization_id);
    }
      await logger.info('login_succeeded', {
        event_name: 'login_succeeded',
        online: navigator.onLine,
        duration_ms: Date.now() - startedAt,
        organization_id: u.organization_id || null,
      });
      toast({ title: 'Login realizado com sucesso!' });
    } catch (error: any) {
      await logger.warn('login_failed', {
        event_name: 'login_failed',
        online: navigator.onLine,
        duration_ms: Date.now() - startedAt,
        error_name: error?.name,
        error_message: error?.message,
      });
      throw error;
    }
  };

  const register = async (email: string, password: string, name: string, planId?: string) => {
    const { user, token } = await authApi.register(email, password, name, planId);
    setAuthToken(token);
    setUser(user);
    toast({ title: 'Conta criada com sucesso!' });
  };

  const logout = () => {
    clearAuthToken();
    setUser(null);
    toast({ title: 'Logout realizado' });
  };

  const modulesEnabled = user?.modules_enabled || defaultModules;
  const pagePermissions = user?.page_permissions || null;

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        modulesEnabled,
        pagePermissions,
        login,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
