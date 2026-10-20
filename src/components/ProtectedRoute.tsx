import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';
import { permissionKeyForPath } from '@/lib/page-permissions';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { isAuthenticated, isLoading, pagePermissions } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Permission template enforcement: when a template is assigned it is
  // authoritative. A page the template does not explicitly grant is denied,
  // even if the user reaches it by typing the URL directly.
  if (pagePermissions) {
    const key = permissionKeyForPath(location.pathname);
    if (key && pagePermissions[key] !== true) {
      return <Navigate to="/sem-acesso" replace />;
    }
  }

  return <>{children}</>;
};

export default ProtectedRoute;
