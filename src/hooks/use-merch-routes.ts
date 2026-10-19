import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ===== ADMIN HOOKS (Fase 4 - Rotas & Execução) =====

const LIVE_ROUTES_ALLOWED_PATHS = new Set(['/merch/execucao', '/live-maps']);

const isLiveRoutesScreenActive = () => {
  if (typeof window === 'undefined') return true;
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  return LIVE_ROUTES_ALLOWED_PATHS.has(pathname);
};

export function useMerchRoutes(filters?: {
  promoter_id?: string; brand_id?: string; pdv_id?: string;
  status?: string; date_from?: string; date_to?: string; supervisor_id?: string;
}) {
  const params = new URLSearchParams();
  if (filters?.promoter_id) params.set('promoter_id', filters.promoter_id);
  if (filters?.brand_id) params.set('brand_id', filters.brand_id);
  if (filters?.pdv_id) params.set('pdv_id', filters.pdv_id);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.date_from) params.set('date_from', filters.date_from);
  if (filters?.date_to) params.set('date_to', filters.date_to);
  if (filters?.supervisor_id) params.set('supervisor_id', filters.supervisor_id);
  const qs = params.toString();
  return useQuery({
    queryKey: ['merch-routes', qs],
    queryFn: () => api<any[]>(`/api/merch/routes${qs ? `?${qs}` : ''}`),
  });
}

export function useMerchRouteDetail(id?: string) {
  return useQuery({
    queryKey: ['merch-route', id],
    queryFn: () => api<any>(`/api/merch/routes/${id}`),
    enabled: !!id,
  });
}

export function useRouteMixPreview(pdvId?: string, brandId?: string) {
  return useQuery({
    queryKey: ['route-mix-preview', pdvId, brandId],
    queryFn: () => api<any[]>(`/api/merch/routes/mix-preview?pdv_id=${pdvId}&brand_id=${brandId}`),
    enabled: !!pdvId && !!brandId,
  });
}

export function useRouteProducts(routeId?: string) {
  return useQuery({
    queryKey: ['route-products', routeId],
    queryFn: () => api<any[]>(`/api/merch/routes/${routeId}/products`),
    enabled: !!routeId,
  });
}

export function useAddRouteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, ...data }: any) => api<any>(`/api/merch/routes/${routeId}/products`, { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['route-products'] }); qc.invalidateQueries({ queryKey: ['merch-route'] }); },
  });
}

export function useRemoveRouteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, productId }: any) => api<any>(`/api/merch/routes/${routeId}/products/${productId}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['route-products'] }); qc.invalidateQueries({ queryKey: ['merch-route'] }); },
  });
}

export function useSyncRouteProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (routeId: string) => api<any[]>(`/api/merch/routes/${routeId}/sync-products`, { method: 'POST' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['route-products'] }); qc.invalidateQueries({ queryKey: ['merch-route'] }); },
  });
}

export function useCreateMerchRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merch/routes', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-routes'] }),
  });
}

export function useUpdateMerchRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/merch/routes/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['merch-routes'] }); qc.invalidateQueries({ queryKey: ['merch-route'] }); },
  });
}

export function useDeleteMerchRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, scope }: { id: string; scope?: string }) =>
      api<any>(`/api/merch/routes/${id}${scope ? `?scope=${scope}` : ''}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-routes'] }),
  });
}
export function useJustifyRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<any>(`/api/merch/routes/${id}/justify`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merch-routes'] });
      qc.invalidateQueries({ queryKey: ['merch-route'] });
      qc.invalidateQueries({ queryKey: ['merch-routes-live'] });
    },
  });
}


export function useBulkDeleteMerchRoutes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, include_future }: { ids: string[]; include_future?: boolean }) =>
      api<any>(`/api/merch/routes/bulk-delete`, { method: 'POST', body: { ids, include_future: !!include_future } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-routes'] }),
  });
}

// Transferencia de rotas de um promotor para outro (admin/superadmin)
export function useTransferPromoterRoutes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      from_promoter_id: string;
      to_promoter_id: string;
      from_date?: string;
      to_date?: string;
      include_completed?: boolean;
      preview?: boolean;
      reason?: string;
    }) => api<any>('/api/merch/routes/transfer-promoter', { method: 'POST', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merch-routes'] });
      qc.invalidateQueries({ queryKey: ['merch-routes-live'] });
      qc.invalidateQueries({ queryKey: ['merch-route'] });
    },
  });
}



export function useDuplicateMerchRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/merch/routes/${id}/duplicate`, { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-routes'] }),
  });
}

export function useManualCompleteRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      api<any>(`/api/merch/routes/${id}/complete`, { method: 'POST', body: { notes } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merch-routes'] });
      qc.invalidateQueries({ queryKey: ['merch-route'] });
      qc.invalidateQueries({ queryKey: ['merch-routes-live'] });
    },
  });
}

export function useLiveRoutes(filters?: { date_from?: string; date_to?: string }) {
  const params = new URLSearchParams();
  if (filters?.date_from) params.set('date_from', filters.date_from);
  if (filters?.date_to) params.set('date_to', filters.date_to);
  const qs = params.toString();
  return useQuery({
    queryKey: ['merch-routes-live', qs],
    enabled: isLiveRoutesScreenActive(),
    queryFn: async () => {
      if (!isLiveRoutesScreenActive()) return [];
      const url = `/api/merch/routes${qs ? `?${qs}` : ''}`;
      try {
        return await api<any[]>(url, { silent: true });
      } catch (err) {
        console.error('Live routes fallback failed:', err);
        return [];
      }
    },

    refetchInterval: (query) => {
      if (!isLiveRoutesScreenActive()) return false;
      return query.state.status === 'error' ? false : 15000;
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 15000,
  });
}

// Brand Checklists
export function useBrandChecklists(brandId?: string) {
  const qs = brandId ? `?brand_id=${brandId}` : '';
  return useQuery({
    queryKey: ['brand-checklists', brandId],
    queryFn: () => api<any[]>(`/api/merch/brand-checklists${qs}`),
  });
}

export function useCreateBrandChecklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merch/brand-checklists', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brand-checklists'] }),
  });
}

export function useUpdateBrandChecklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/merch/brand-checklists/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brand-checklists'] }),
  });
}

export function useDeleteBrandChecklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/merch/brand-checklists/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brand-checklists'] }),
  });
}

// Damages (admin)
export function useMerchDamages(filters?: { brand_id?: string; pdv_id?: string; product_id?: string; status?: string }) {
  const params = new URLSearchParams();
  if (filters?.brand_id) params.set('brand_id', filters.brand_id);
  if (filters?.pdv_id) params.set('pdv_id', filters.pdv_id);
  if (filters?.product_id) params.set('product_id', filters.product_id);
  if (filters?.status) params.set('status', filters.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['merch-damages', qs],
    queryFn: () => api<any[]>(`/api/merch/damages${qs ? `?${qs}` : ''}`),
  });
}

// Return Requests
export function useReturnRequests() {
  return useQuery({
    queryKey: ['return-requests'],
    queryFn: () => api<any[]>('/api/merch/return-requests'),
  });
}

// Photo Settings
export function usePhotoSettings() {
  return useQuery({
    queryKey: ['photo-settings'],
    queryFn: () => api<any[]>('/api/merch/photo-settings'),
  });
}

export function useCreatePhotoSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merch/photo-settings', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['photo-settings'] }),
  });
}

// Brand Promoters
export function useBrandPromoters(brandId?: string) {
  const qs = brandId ? `?brand_id=${brandId}` : '';
  return useQuery({
    queryKey: ['brand-promoters', brandId],
    queryFn: () => api<any[]>(`/api/merch/brand-promoters${qs}`),
    enabled: !!brandId,
  });
}

export function useCreateBrandPromoter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merch/brand-promoters', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brand-promoters'] }),
  });
}

export function useRouteAuditLogs(routeId?: string) {
  return useQuery({
    queryKey: ['route-audit', routeId],
    queryFn: () => api<any[]>(`/api/merch/routes/${routeId}/audit`),
    enabled: !!routeId,
  });
}

export function useContingencyPhotoUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, ...data }: any) => api<any>(`/api/merch/routes/${routeId}/contingency-photos`, { method: 'POST', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merch-route'] });
      qc.invalidateQueries({ queryKey: ['merch-routes'] });
      qc.invalidateQueries({ queryKey: ['photo-book'] });
    },
  });
}

export function useAssignPromoter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, ...data }: any) => api<any>(`/api/merch/routes/${routeId}/assign-promoter`, { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['merch-routes'] }); qc.invalidateQueries({ queryKey: ['merch-route'] }); },
  });
}

// Photo Book
export function usePhotoBook(filters?: { brand_id?: string; pdv_id?: string; date_from?: string; date_to?: string; promoter_id?: string; category_id?: string; photo_type?: string; supervisor_id?: string; rede_id?: string; city?: string }) {
  const params = new URLSearchParams();
  if (filters?.brand_id) params.set('brand_id', filters.brand_id);
  if (filters?.pdv_id) params.set('pdv_id', filters.pdv_id);
  if (filters?.date_from) params.set('date_from', filters.date_from);
  if (filters?.date_to) params.set('date_to', filters.date_to);
  if (filters?.promoter_id) params.set('promoter_id', filters.promoter_id);
  if (filters?.category_id) params.set('category_id', filters.category_id);
  if (filters?.photo_type) params.set('photo_type', filters.photo_type);
  if (filters?.supervisor_id) params.set('supervisor_id', filters.supervisor_id);
  if (filters?.rede_id) params.set('rede_id', filters.rede_id);
  if (filters?.city) params.set('city', filters.city);
  const qs = params.toString();
  return useQuery({
    queryKey: ['photo-book', qs],
    queryFn: () => api<any[]>(`/api/merch/photo-book${qs ? `?${qs}` : ''}`),
  });
}

export function useRotatePhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, delta, rotation }: { id: string; delta?: number; rotation?: number }) =>
      api<any>(`/api/merch/photos/${id}/rotate`, { method: 'PATCH', body: { delta, rotation } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['photo-book'] });
      qc.invalidateQueries({ queryKey: ['merch-route'] });
    },
  });
}

// Route Authors
export function useRouteAuthors(routeId?: string) {
  return useQuery({
    queryKey: ['route-authors', routeId],
    queryFn: () => api<any[]>(`/api/merch/routes/${routeId}/authors`),
    enabled: !!routeId,
  });
}

// Route Assignment History
export function useRouteAssignmentHistory(routeId?: string) {
  return useQuery({
    queryKey: ['route-assign-history', routeId],
    queryFn: () => api<any[]>(`/api/merch/routes/${routeId}/assignment-history`),
    enabled: !!routeId,
  });
}

// Promoters Team (admin)
export function useMerchPromoters() {
  return useQuery({
    queryKey: ['merch-promoters-team'],
    queryFn: () => api<any[]>('/api/merch/promoters-team'),
  });
}

// AI Route Optimization
export function useOptimizationContext(filters?: {
  promoter_ids?: string; brand_id?: string; date_from?: string; date_to?: string; region?: string;
}) {
  const params = new URLSearchParams();
  if (filters?.promoter_ids) params.set('promoter_ids', filters.promoter_ids);
  if (filters?.brand_id) params.set('brand_id', filters.brand_id);
  if (filters?.date_from) params.set('date_from', filters.date_from);
  if (filters?.date_to) params.set('date_to', filters.date_to);
  if (filters?.region) params.set('region', filters.region);
  const qs = params.toString();
  return useQuery({
    queryKey: ['ai-optimization-context', qs],
    queryFn: () => api<any>(`/api/merch/ai/optimization-context${qs ? `?${qs}` : ''}`),
    enabled: !!(filters?.date_from && filters?.date_to),
  });
}

export function useAIOptimize() {
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merch/ai/optimize', { method: 'POST', body: data }),
  });
}

export function useAIApprove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merch/ai/approve', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-routes'] }),
  });
}

export function useWorkload(filters?: { promoter_id?: string; date_from?: string; date_to?: string }) {
  const params = new URLSearchParams();
  if (filters?.promoter_id) params.set('promoter_id', filters.promoter_id);
  if (filters?.date_from) params.set('date_from', filters.date_from);
  if (filters?.date_to) params.set('date_to', filters.date_to);
  const qs = params.toString();
  return useQuery({
    queryKey: ['merch-workload', qs],
    queryFn: () => api<any[]>(`/api/merch/workload${qs ? `?${qs}` : ''}`),
    enabled: !!(filters?.date_from && filters?.date_to),
  });
}
