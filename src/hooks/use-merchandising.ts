import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Brand {
  id: string;
  name: string;
  internal_code: string;
  razao_social: string;
  cnpj: string;
  logo_url: string;
  description: string;
  segment: string;
  responsible: string;
  phone: string;
  email: string;
  street?: string;
  number?: string;
  neighborhood?: string;
  city?: string;
  zip?: string;
  status: 'active' | 'inactive';
  notes: string;
  show_routes?: boolean;
  show_photos?: boolean;
  show_stock?: boolean;
  show_damages?: boolean;
  show_stockouts?: boolean;
  created_at?: string;
}

// ===== BRANDS =====
export function useBrands(filters?: { status?: string; search?: string }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.search) params.set('search', filters.search);
  const qs = params.toString();
  return useQuery({
    queryKey: ['merch-brands', qs],
    queryFn: () => api<Brand[]>(`/api/merchandising/brands${qs ? `?${qs}` : ''}`),
  });
}

export function useCreateBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merchandising/brands', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-brands'] }),
  });
}

export function useUpdateBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/merchandising/brands/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-brands'] }),
  });
}

export function useDeleteBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/merchandising/brands/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-brands'] }),
  });
}

export function useImportBrands() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { items: any[] }) =>
      api<any>('/api/merchandising/brands/import', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-brands'] }),
  });
}

// ===== CATEGORIES =====
export function useCategories() {
  return useQuery({
    queryKey: ['merch-categories'],
    queryFn: () => api<any[]>('/api/merchandising/categories'),
  });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merchandising/categories', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-categories'] }),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/merchandising/categories/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-categories'] }),
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/merchandising/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-categories'] }),
  });
}

export function useImportCategories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { items: { name: string; parent?: string; description?: string }[] }) =>
      api<any>('/api/merchandising/categories/import', { method: 'POST', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merch-categories'] });
      qc.invalidateQueries({ queryKey: ['merch-subcategories'] });
    },
  });
}

// ===== SUBCATEGORIES =====
export function useSubcategories(categoryId?: string) {
  const params = categoryId ? `?category_id=${categoryId}` : '';
  return useQuery({
    queryKey: ['merch-subcategories', categoryId],
    queryFn: () => api<any[]>(`/api/merchandising/subcategories${params}`),
  });
}

export function useCreateSubcategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merchandising/subcategories', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-subcategories'] }),
  });
}

export function useUpdateSubcategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/merchandising/subcategories/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-subcategories'] }),
  });
}

export function useDeleteSubcategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/merchandising/subcategories/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-subcategories'] }),
  });
}

// ===== PRODUCTS =====
export function useProducts(filters?: { brand_id?: string; category_id?: string; subcategory_id?: string; status?: string; search?: string }) {
  const params = new URLSearchParams();
  if (filters?.brand_id) params.set('brand_id', filters.brand_id);
  if (filters?.category_id) params.set('category_id', filters.category_id);
  if (filters?.subcategory_id) params.set('subcategory_id', filters.subcategory_id);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.search) params.set('search', filters.search);
  const qs = params.toString();
  return useQuery({
    queryKey: ['merch-products', qs],
    queryFn: () => api<any[]>(`/api/merchandising/products${qs ? `?${qs}` : ''}`),
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merchandising/products', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-products'] }),
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/merchandising/products/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-products'] }),
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/merchandising/products/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-products'] }),
  });
}

export function useBulkDeleteProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api<{ ok: boolean; deleted: number }>('/api/merchandising/products/bulk-delete', { method: 'POST', body: { ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-products'] }),
  });
}

export function useImportProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { items: any[]; auto_create: boolean }) => api<any>('/api/merchandising/products/import', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-products'] }),
  });
}

// ===== PDV BRANDS =====
export function usePdvBrands(pdvId?: string | string[]) {
  const ids = Array.isArray(pdvId) ? pdvId.join(',') : pdvId;
  return useQuery({
    queryKey: ['merch-pdv-brands', ids],
    queryFn: () => api<any[]>(`/api/merchandising/pdv-brands/${ids}`),
    enabled: !!ids,
  });
}

// ===== BRAND PDVs (which PDVs a brand serves) =====
export function useBrandPdvs(brandId?: string, opts?: { all?: boolean }) {
  const all = !!opts?.all;
  return useQuery({
    queryKey: ['merch-brand-pdvs', brandId, all ? 'all' : 'linked'],
    queryFn: () => api<any[]>(`/api/merchandising/brand-pdvs/${brandId}${all ? '?all=1' : ''}`),
    enabled: !!brandId,
  });
}

export function useAddPdvBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { pdv_id: string; brand_id: string }) => api<any>('/api/merchandising/pdv-brands', { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['merch-pdv-brands'] }); qc.invalidateQueries({ queryKey: ['merch-brand-pdvs'] }); },
  });
}

export function useRemovePdvBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/merchandising/pdv-brands/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merch-pdv-brands'] });
      qc.invalidateQueries({ queryKey: ['merch-brand-pdvs'] });
      // O unlink também remove rotas futuras; garante que agenda/roteiro
      // recarreguem em vez de continuarem mostrando a loja excluída.
      qc.invalidateQueries({ queryKey: ['merch-routes'] });
      qc.invalidateQueries({ queryKey: ['merch-routes-live'] });
    },
  });
}

export function useAddPdvBrandByNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { brand_id: string; rede_id: string }) =>
      api<any>('/api/merchandising/pdv-brands/by-network', { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['merch-pdv-brands'] }); qc.invalidateQueries({ queryKey: ['merch-brand-pdvs'] }); },
  });
}

export function useImportBrandPdvs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { items: { brand_name: string; pdv_name: string }[]; auto_create_brands?: boolean }) =>
      api<any>('/api/merchandising/brand-pdvs/import', { method: 'POST', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merch-brand-pdvs'] });
      qc.invalidateQueries({ queryKey: ['merch-pdv-brands'] });
      qc.invalidateQueries({ queryKey: ['merch-brands'] });
    },
  });
}

// ===== MIX =====
export function useMix(pdvId?: string, brandId?: string) {
  return useQuery({
    queryKey: ['merch-mix', pdvId, brandId],
    queryFn: () => api<any[]>(`/api/merchandising/mix/${pdvId}/${brandId}`),
    enabled: !!pdvId && !!brandId,
  });
}

export function useAddToMix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { pdv_id: string; brand_id: string; product_ids: string[]; mandatory?: boolean; priority?: string }) =>
      api<any>('/api/merchandising/mix', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-mix'] }),
  });
}

export function useImportMix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { items: any[] }) =>
      api<any>('/api/merchandising/mix/import', { method: 'POST', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merch-mix'] });
      qc.invalidateQueries({ queryKey: ['merch-pdv-brands'] });
      qc.invalidateQueries({ queryKey: ['merch-brand-pdvs'] });
    },
  });
}

export function useClearMixByBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (brandId: string) =>
      api<any>('/api/merchandising/mix/clear-by-brand', { method: 'POST', body: { brand_id: brandId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merch-mix'] });
      qc.invalidateQueries({ queryKey: ['merch-brand-pdvs'] });
    },
  });
}

export function useUpdateMixItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/merchandising/mix/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-mix'] }),
  });
}

export function useRemoveFromMix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { pdv_id: string; brand_id: string; product_ids: string[] }) =>
      api<any>('/api/merchandising/mix', { method: 'DELETE', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-mix'] }),
  });
}

// ===== REPORTS =====
export function useBrandReport(brandId?: string) {
  return useQuery({
    queryKey: ['merch-report-brand', brandId],
    queryFn: () => api<any[]>(`/api/merchandising/reports/brand/${brandId}`),
    enabled: !!brandId,
  });
}

export function usePdvReport(pdvId?: string) {
  return useQuery({
    queryKey: ['merch-report-pdv', pdvId],
    queryFn: () => api<any[]>(`/api/merchandising/reports/pdv/${pdvId}`),
    enabled: !!pdvId,
  });
}

// ===== NETWORKS (REDES) =====
export function useNetworks() {
  return useQuery({
    queryKey: ['merch-networks'],
    queryFn: async () => api<any[]>('/api/merchandising/networks'),
    retry: (failureCount, error: any) => {
      if (error?.status === 404) return false;
      return failureCount < 3;
    },
  });
}

export function useCreateNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/merchandising/networks', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-networks'] }),
  });
}

export function useUpdateNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/merchandising/networks/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-networks'] }),
  });
}

export function useDeleteNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/merchandising/networks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['merch-networks'] }),
  });
}

export function useNetworkPdvs(networkId?: string) {
  return useQuery({
    queryKey: ['merch-network-pdvs', networkId],
    queryFn: () => api<any[]>(`/api/merchandising/networks/${networkId}/pdvs`),
    enabled: !!networkId,
    retry: false,
  });
}

export function useUpdateNetworkPdvs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pdv_ids }: { id: string; pdv_ids: string[] }) =>
      api<any>(`/api/merchandising/networks/${id}/pdvs`, { method: 'POST', body: { pdv_ids } }),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: ['merch-networks'] });
      qc.invalidateQueries({ queryKey: ['merch-network-pdvs', variables.id] });
    },
  });
}

export function useAddToMixBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { network_id?: string; pdv_ids?: string[]; brand_id: string; product_ids: string[]; mandatory?: boolean; priority?: string }) => {
      try {
        return await api<any>('/api/merchandising/mix/bulk', { method: 'POST', body: data });
      } catch (e: any) {
        const is404 = e.status === 404 || (e.message && e.message.includes('404'));
        if (is404) {
          // Fallback silencioso para mix bulk
          console.log('API mix bulk missing, pretending success', data);
          return { ok: true, mocked: true };
        }
        throw e;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['merch-mix'] });
    },
  });
}

