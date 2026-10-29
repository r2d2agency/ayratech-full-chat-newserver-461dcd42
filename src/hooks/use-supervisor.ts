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
