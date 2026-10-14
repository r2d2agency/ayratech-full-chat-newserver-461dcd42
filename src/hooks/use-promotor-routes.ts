import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Cache constants for offline access
const ROUTE_CACHE_TIME = 1000 * 60 * 60 * 24; // 24 hours
const ROUTE_STALE_TIME = 1000 * 60 * 30; // 30 minutes

// Promotor API helper (uses promotor_token)
const promotorApi = async <T>(endpoint: string, options: any = {}): Promise<T> => {
  return api<T>(endpoint, {
    ...options,
    auth: true,
  });
};

// ===== PROMOTOR ROUTE HOOKS =====

export function usePromotorAgenda(filters?: { date_from?: string; date_to?: string }) {
  const params = new URLSearchParams();
  if (filters?.date_from) params.set('date_from', filters.date_from);
  if (filters?.date_to) params.set('date_to', filters.date_to);
  const qs = params.toString();
  return useQuery({
    queryKey: ['promotor-agenda', qs],
    queryFn: () => promotorApi<any[]>(`/api/merch/promotor/agenda${qs ? `?${qs}` : ''}`),
  });
}

export function usePromotorPendingJustifications() {
  return useQuery({
    queryKey: ['promotor-pending-justifications'],
    queryFn: () => promotorApi<any[]>(`/api/merch/promotor/pending-justifications`),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export function usePromotorJustifyRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      promotorApi<any>(`/api/merch/promotor/routes/${id}/justify`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['promotor-pending-justifications'] });
      qc.invalidateQueries({ queryKey: ['promotor-agenda'] });
      qc.invalidateQueries({ queryKey: ['promotor-home'] });
    },
  });
}

export function usePromotorRouteDetail(id?: string) {
  return useQuery({
    queryKey: ['promotor-route', id],
    queryFn: () => promotorApi<any>(`/api/merch/promotor/routes/${id}`),
    enabled: !!id,
    staleTime: ROUTE_STALE_TIME,
    gcTime: ROUTE_CACHE_TIME,
    retry: (failureCount, error) => {
      // Don't retry on 404 (route not found) or 403
      if (error?.message?.includes('not found') || error?.message?.includes('404')) return false;
      return failureCount < 2;
    },
  });
}

export function usePromotorCheckin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => promotorApi<any>(`/api/merch/promotor/routes/${id}/checkin`, { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotor-agenda'] }); qc.invalidateQueries({ queryKey: ['promotor-route'] }); qc.invalidateQueries({ queryKey: ['promotor-home'] }); },
  });
}

export function usePromotorCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => promotorApi<any>(`/api/merch/promotor/routes/${id}/checkout`, { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotor-agenda'] }); qc.invalidateQueries({ queryKey: ['promotor-route'] }); qc.invalidateQueries({ queryKey: ['promotor-home'] }); },
  });
}

export function usePromotorUpdateExecution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => promotorApi<any>(`/api/merch/promotor/executions/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-route'] }),
  });
}

export function usePromotorAddValidity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ executionId, ...data }: any) => promotorApi<any>(`/api/merch/promotor/executions/${executionId}/validity`, { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-route'] }),
  });
}

export function usePromotorReportRupture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ executionId, ...data }: any) => promotorApi<any>(`/api/merch/promotor/executions/${executionId}/rupture`, { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-route'] }),
  });
}

export function usePromotorReportDamage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ executionId, ...data }: any) => promotorApi<any>(`/api/merch/promotor/executions/${executionId}/damage`, { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotor-route'] }); qc.invalidateQueries({ queryKey: ['promotor-damages'] }); },
  });
}

export function usePromotorReportDiscard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ executionId, ...data }: any) => promotorApi<any>(`/api/merch/promotor/executions/${executionId}/discard`, { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-route'] }),
  });
}

export function usePromotorUploadPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, ...data }: any) => promotorApi<any>(`/api/merch/promotor/routes/${routeId}/photos`, { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-route'] }),
  });
}

export function usePromotorDamages(status?: string) {
  const qs = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['promotor-damages', status],
    queryFn: () => promotorApi<any[]>(`/api/merch/promotor/damages${qs}`),
  });
}

export function usePromotorRequestReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => promotorApi<any>('/api/merch/promotor/return-requests', { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotor-damages'] }); },
  });
}

export function usePromotorUploadInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => promotorApi<any>('/api/merch/promotor/return-invoices', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-damages'] }),
  });
}

export function usePromotorPostpone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => promotorApi<any>('/api/merch/promotor/postpone', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-route'] }),
  });
}

export function usePromotorSetPointType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ routeId, catId, point_type, route_brand_id, ...data }: { routeId: string; catId: string; point_type: string; route_brand_id?: string; [key: string]: any }) => {
      const normalized = point_type === 'extra' ? 'EXTRA' : 'NATURAL';
      return promotorApi<any>(
        `/api/merch/promotor/routes/${routeId}/categories/${catId}/point-type`,
        { 
          method: 'POST', 
          body: { 
            point_type: point_type.toLowerCase(), 
            pointType: normalized,
            route_brand_id,
            ...data
          } 
        }
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-route'] }),
  });
}

export function usePromotorCategoryPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, catId, route_brand_id, ...data }: { routeId: string; catId: string; route_brand_id?: string; photo_url: string; photos?: string[]; latitude?: number; longitude?: number }) =>
      promotorApi<any>(`/api/merch/promotor/routes/${routeId}/categories/${catId}/photo`, { method: 'POST', body: { ...data, route_brand_id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-route'] }),
  });
}

export function usePromotorCategoryAfterPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, catId, route_brand_id, ...data }: { routeId: string; catId: string; route_brand_id?: string; photo_url: string; photos?: string[]; latitude?: number; longitude?: number }) =>
      promotorApi<any>(`/api/merch/promotor/routes/${routeId}/categories/${catId}/after-photo`, { method: 'POST', body: { ...data, route_brand_id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-route'] }),
  });
}

export function usePromotorRegisterExtraPoint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, catId, product_ids }: { routeId: string; catId: string; product_ids: string[] }) =>
      promotorApi<any>(`/api/merch/promotor/routes/${routeId}/categories/${catId}/extra-point`, { method: 'POST', body: { product_ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-route'] }),
  });
}
