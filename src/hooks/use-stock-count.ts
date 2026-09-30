import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useStockCountRules(brandId?: string) {
  const params = brandId ? `?brand_id=${brandId}` : '';
  return useQuery({
    queryKey: ['stock-count-rules', brandId],
    queryFn: () => api<any[]>(`/api/stock-count/rules${params}`),
  });
}

export function useUpsertStockCountRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/stock-count/rules', { method: 'POST', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stock-count-rules'] });
      qc.invalidateQueries({ queryKey: ['stock-count-route'] });
      qc.invalidateQueries({ queryKey: ['promotor-agenda'] });
      qc.invalidateQueries({ queryKey: ['merch-routes'] });
    },
  });
}

export function useDeleteStockCountRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/stock-count/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stock-count-rules'] }),
  });
}

export function useRouteStockCount(routeId?: string) {
  return useQuery({
    queryKey: ['stock-count-route', routeId],
    queryFn: () => api<any[]>(`/api/stock-count/route/${routeId}`),
    enabled: !!routeId,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export function useExecuteStockCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/stock-count/execute', { method: 'POST', body: data }),
    onSuccess: (_, vars: any) => {
      qc.invalidateQueries({ queryKey: ['stock-count-route', vars.route_id] });
    },
  });
}

export function usePostponeStockCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { execution_id: string; reason: string; observation?: string }) =>
      api<any>('/api/stock-count/postpone', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stock-count-route'] }),
  });
}

export function useJustifyStockCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { execution_id: string; reason: string; observation?: string }) =>
      api<any>('/api/stock-count/justify', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stock-count-route'] }),
  });
}

export function useStockCountExecutions(filters: {
  from?: string; to?: string; brand_id?: string; pdv_id?: string; promoter_id?: string; status?: string;
} = {}) {
  const params = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => !!v) as [string, string][]
  ).toString();
  return useQuery({
    queryKey: ['stock-count-executions', filters],
    queryFn: () => api<any[]>(`/api/stock-count/executions${params ? `?${params}` : ''}`),
  });
}

export function useStockCountExecutionDetail(id?: string) {
  return useQuery({
    queryKey: ['stock-count-execution', id],
    queryFn: () => api<any>(`/api/stock-count/executions/${id}`),
    enabled: !!id,
  });
}

export function useResendStockCountEmail() {
  return useMutation({
    mutationFn: (data: { execution_id: string; extra_emails?: string }) =>
      api<any>(`/api/stock-count/executions/${data.execution_id}/resend-email`, {
        method: 'POST', body: { extra_emails: data.extra_emails },
      }),
  });
}
