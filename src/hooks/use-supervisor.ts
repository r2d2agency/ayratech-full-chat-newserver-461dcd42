import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const supervisorApi = async <T>(endpoint: string, options: any = {}): Promise<T> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('supervisor_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url = `${(import.meta.env.VITE_API_URL || '').replace(/\/$/, '')}${endpoint}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || 'Erro');
  return data as T;
};

export { supervisorApi };

export function useSupervisorMe() {
  return useQuery({
    queryKey: ['supervisor-me'],
    queryFn: () => supervisorApi<any>('/api/supervisor/me'),
  });
}

export function useSupervisorRoutes(filters?: { promoter_id?: string; date_from?: string; date_to?: string }) {
  const params = new URLSearchParams();
  if (filters?.promoter_id) params.set('promoter_id', filters.promoter_id);
  if (filters?.date_from) params.set('date_from', filters.date_from);
  if (filters?.date_to) params.set('date_to', filters.date_to);
  const qs = params.toString();
  return useQuery({
    queryKey: ['supervisor-routes', qs],
    queryFn: () => supervisorApi<any[]>(`/api/supervisor/routes${qs ? `?${qs}` : ''}`),
  });
}

export function useSupervisorUpdateRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => supervisorApi<any>(`/api/supervisor/routes/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supervisor-routes'] }),
  });
}

export function useSupervisorAddSupport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, employee_id }: any) => supervisorApi<any>(`/api/supervisor/routes/${routeId}/support`, { method: 'POST', body: { employee_id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supervisor-routes'] }),
  });
}
