import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ===== PROMOTOR APP HOOKS (used by collaborator app) =====

const promotorApi = async <T>(endpoint: string, options: any = {}): Promise<T> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('promotor_token') || localStorage.getItem('supervisor_token');
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

export function usePromotorHome() {
  return useQuery({
    queryKey: ['promotor-home'],
    queryFn: () => promotorApi<any>('/api/promotor/home'),
    refetchInterval: 30000,
  });
}

export function usePromotorPunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => promotorApi<any>('/api/promotor/punch', { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotor-home'] }); qc.invalidateQueries({ queryKey: ['promotor-punches'] }); },
  });
}

export function usePromotorOvertimeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => promotorApi<any>('/api/promotor/overtime-request', { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotor-home'] }); qc.invalidateQueries({ queryKey: ['promotor-overtime'] }); },
  });
}

export function usePromotorOvertimeRequests() {
  return useQuery({
    queryKey: ['promotor-overtime'],
    queryFn: () => promotorApi<any[]>('/api/promotor/overtime-requests'),
  });
}

// Supervisor: get pending overtime requests from subordinates
export function useSupervisorOvertimeRequests() {
  return useQuery({
    queryKey: ['supervisor-overtime-requests'],
    queryFn: () => promotorApi<any[]>('/api/promotor/supervisor/overtime-requests'),
    refetchInterval: 30000,
  });
}

// Supervisor: approve/reject overtime request
export function useSupervisorApproveOvertime() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; status: string; supervisor_notes?: string }) =>
      promotorApi<any>(`/api/promotor/supervisor/overtime-requests/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['supervisor-overtime-requests'] }); },
  });
}

// Supervisor: get list of managed promoters
export function useSupervisorTeam() {
  return useQuery({
    queryKey: ['supervisor-team'],
    queryFn: () => promotorApi<any[]>('/api/promotor/supervisor/team'),
    refetchInterval: 60000,
  });
}

// Supervisor: send notification to a specific promoter
export function useSupervisorSendNotification() {
  return useMutation({
    mutationFn: (data: { employee_id: string; title: string; message?: string }) =>
      promotorApi<any>('/api/promotor/supervisor/send-notification', { method: 'POST', body: data }),
  });
}

// Supervisor: send file/document to RH
export function useSupervisorSendToRH() {
  return useMutation({
    mutationFn: (data: { title: string; message?: string; file_url?: string; category?: string }) =>
      promotorApi<any>('/api/promotor/supervisor/send-to-rh', { method: 'POST', body: data }),
  });
}

// RH side hooks
export function useRhOvertimeRequests(filters?: { status?: string }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-overtime-requests', qs],
    queryFn: () => api<any[]>(`/api/promotor/rh/overtime-requests${qs ? `?${qs}` : ''}`),
  });
}

export function useApproveOvertimeRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/promotor/rh/overtime-requests/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-overtime-requests'] }),
  });
}

// Location tracking - sends GPS updates every 60s during work hours
export function useLocationTracking() {
  useEffect(() => {
    const token = localStorage.getItem('promotor_token');
    if (!token || !navigator.geolocation) return;

    const sendLocation = () => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            await promotorApi('/api/promotor/location-update', {
              method: 'POST',
              body: {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy_meters: pos.coords.accuracy,
                battery_level: (navigator as any).getBattery ? await (navigator as any).getBattery().then((b: any) => Math.round(b.level * 100)).catch(() => null) : null,
                is_moving: pos.coords.speed ? pos.coords.speed > 0.5 : false,
              },
            });
          } catch { /* silent */ }
        },
        () => { /* GPS denied/unavailable - silent */ },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    };

    sendLocation();
    const interval = setInterval(sendLocation, 60000); // every 60s
    return () => clearInterval(interval);
  }, []);
}

export function usePromotorPunches(filters?: { start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters?.start_date) params.set('start_date', filters.start_date);
  if (filters?.end_date) params.set('end_date', filters.end_date);
  const qs = params.toString();
  return useQuery({
    queryKey: ['promotor-punches', qs],
    queryFn: () => promotorApi<any[]>(`/api/promotor/punches${qs ? `?${qs}` : ''}`),
  });
}

export function usePromotorDocuments(status?: string) {
  const qs = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['promotor-documents', status],
    queryFn: () => promotorApi<any[]>(`/api/promotor/documents${qs}`),
  });
}

export function usePromotorViewDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => promotorApi<any>(`/api/promotor/documents/${id}/view`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-documents'] }),
  });
}

export function usePromotorConfirmDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => promotorApi<any>(`/api/promotor/documents/${id}/confirm`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-documents'] }),
  });
}

export function usePromotorRefuseDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => promotorApi<any>(`/api/promotor/documents/${id}/refuse`, { method: 'POST', body: { reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-documents'] }),
  });
}

export function usePromotorInboundDocuments() {
  return useQuery({
    queryKey: ['promotor-inbound-docs'],
    queryFn: () => promotorApi<any[]>('/api/promotor/inbound-documents'),
  });
}

export function usePromotorSendDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => promotorApi<any>('/api/promotor/inbound-documents', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-inbound-docs'] }),
  });
}

export function usePromotorPayslips() {
  return useQuery({
    queryKey: ['promotor-payslips'],
    queryFn: () => promotorApi<any[]>('/api/promotor/payslips'),
  });
}

export function usePromotorTimesheets() {
  return useQuery({
    queryKey: ['promotor-timesheets'],
    queryFn: () => promotorApi<any[]>('/api/promotor/timesheets'),
  });
}

export function usePromotorNotifications() {
  return useQuery({
    queryKey: ['promotor-notifications'],
    queryFn: () => promotorApi<any[]>('/api/promotor/notifications'),
    refetchInterval: 30000,
  });
}

export function usePromotorMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => promotorApi<any>(`/api/promotor/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-notifications'] }),
  });
}

export function usePromotorSettings() {
  return useQuery({
    queryKey: ['promotor-settings'],
    queryFn: () => promotorApi<any>('/api/promotor/settings'),
  });
}

export function usePromotorUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => promotorApi<any>('/api/promotor/settings', { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-settings'] }),
  });
}

export function usePromotorChangePassword() {
  return useMutation({
    mutationFn: (data: { current_password?: string; new_password: string }) =>
      promotorApi<any>('/api/promotor/change-password', { method: 'POST', body: data }),
  });
}

export function usePromotorSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (events: any[]) => promotorApi<any>('/api/promotor/sync', { method: 'POST', body: { events } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotor-home'] }); qc.invalidateQueries({ queryKey: ['promotor-punches'] }); },
  });
}

// ===== RH-SIDE HOOKS (used by RH panel) =====

export function usePDVs() {
  return useQuery({ queryKey: ['rh-pdvs'], queryFn: () => api<any[]>('/api/promotor/rh/pdvs') });
}

export function useCreatePDV() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/promotor/rh/pdvs', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-pdvs'] }),
  });
}

export function useUpdatePDV() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/promotor/rh/pdvs/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-pdvs'] }),
  });
}

export function useDeletePDV() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/promotor/rh/pdvs/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-pdvs'] }),
  });
}

export function useDocumentDeliveries(filters?: { employee_id?: string; status?: string }) {
  const params = new URLSearchParams();
  if (filters?.employee_id) params.set('employee_id', filters.employee_id);
  if (filters?.status) params.set('status', filters.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-doc-deliveries', qs],
    queryFn: () => api<any[]>(`/api/promotor/rh/document-deliveries${qs ? `?${qs}` : ''}`),
  });
}

export function useSendDocumentDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/promotor/rh/document-deliveries', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-doc-deliveries'] }),
  });
}

export function useInboundDocumentsRH(filters?: { status?: string; employee_id?: string }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.employee_id) params.set('employee_id', filters.employee_id);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-inbound-docs', qs],
    queryFn: () => api<any[]>(`/api/promotor/rh/inbound-documents${qs ? `?${qs}` : ''}`),
  });
}

export function usePunchMonitor() {
  return useQuery({
    queryKey: ['rh-punch-monitor'],
    queryFn: () => api<any>('/api/promotor/rh/punch-monitor'),
    refetchInterval: 15000,
  });
}

export function useGrantAppAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/promotor/rh/grant-access', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-employees'] }),
  });
}

export function useBlockAppAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (employee_id: string) => api<any>('/api/promotor/rh/block-access', { method: 'POST', body: { employee_id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-employees'] }),
  });
}

export function useResetAppPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { employee_id: string; new_password: string }) => api<any>('/api/promotor/rh/reset-password', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-employees'] }),
  });
}

export function useAppAccess(employeeId?: string) {
  return useQuery({
    queryKey: ['rh-app-access', employeeId],
    queryFn: () => api<any>(`/api/promotor/rh/app-access?employee_id=${employeeId}`),
    enabled: !!employeeId,
  });
}

export function useTimesheetExports(filters?: { employee_id?: string; reference_month?: string }) {
  const params = new URLSearchParams();
  if (filters?.employee_id) params.set('employee_id', filters.employee_id);
  if (filters?.reference_month) params.set('reference_month', filters.reference_month);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-timesheets', qs],
    queryFn: () => api<any[]>(`/api/promotor/rh/timesheets${qs ? `?${qs}` : ''}`),
  });
}

export function useDocumentTypes() {
  return useQuery({ queryKey: ['rh-doc-types'], queryFn: () => api<any[]>('/api/promotor/rh/document-types') });
}

export function useCreateDocumentType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/promotor/rh/document-types', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-doc-types'] }),
  });
}

export function useSendNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { title: string; message?: string; employee_ids: string[]; type?: string }) =>
      api<any>('/api/promotor/rh/send-notice', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-doc-deliveries'] }),
  });
}

export function useImportPDVs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { items: any[] }) => api<any>('/api/promotor/rh/pdvs/import', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-pdvs'] }),
  });
}

// ===== PROMOTOR APP: BIOMETRIA FACIAL (self-enroll) =====
export function usePromotorFaceEnrollment() {
  return useQuery<{ enrolled: boolean; face_photo_url: string | null; face_enrolled_at: string | null }>({
    queryKey: ['promotor-face-enrollment'],
    queryFn: () => promotorApi('/api/promotor/face-enrollment'),
  });
}

export function usePromotorSaveFaceEnrollment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { descriptor: number[]; landmarks?: number[][]; imageDataUrl?: string; geometricProfile?: any; selfTestScore?: number }) =>
      promotorApi<any>('/api/promotor/face-enrollment', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotor-face-enrollment'] }),
  });
}
