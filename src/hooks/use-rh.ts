import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ===== EMPLOYEES =====
export function useEmployees(filters?: { status?: string; search?: string; department_id?: string; branch_id?: string }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.department_id) params.set('department_id', filters.department_id);
  if (filters?.branch_id) params.set('branch_id', filters.branch_id);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-employees', qs],
    queryFn: () => api<any[]>(`/api/rh/employees${qs ? `?${qs}` : ''}`),
  });
}

export function useEmployee(id?: string) {
  return useQuery({
    queryKey: ['rh-employee', id],
    queryFn: () => api<any>(`/api/rh/employees/${id}`),
    enabled: !!id,
  });
}

export function useCreateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/employees', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-employees'] }),
  });
}

export function useUpdateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/rh/employees/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rh-employees'] });
      qc.invalidateQueries({ queryKey: ['rh-employee'] });
    },
  });
}

export function useSyncEmployeeSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, schedule_id }: { id: string; schedule_id: string }) =>
      api<any>(`/api/rh/employees/${id}/sync-schedule`, { method: 'POST', body: { schedule_id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rh-employees'] });
      qc.invalidateQueries({ queryKey: ['rh-employee'] });
    },
  });
}

export function useFacialAlerts() {
  return useQuery({
    queryKey: ['rh-facial-alerts'],
    queryFn: () => api<any[]>('/api/rh/facial-recognition/disabled-alerts'),
  });
}

export function useDeleteEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: string | { id: string; hard?: boolean }) => {
      const id = typeof input === 'string' ? input : input.id;
      const hard = typeof input === 'string' ? false : !!input.hard;
      const url = `/api/rh/employees/${id}${hard ? '?hard=true' : ''}`;
      return api<any>(url, { method: 'DELETE' });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-employees'] }),
  });
}

// ===== TIME RECORDS =====
export function useTimeRecords(filters?: { employee_id?: string; start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters?.employee_id) params.set('employee_id', filters.employee_id);
  if (filters?.start_date) params.set('start_date', filters.start_date);
  if (filters?.end_date) params.set('end_date', filters.end_date);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-time-records', qs],
    queryFn: () => api<any[]>(`/api/rh/time-records${qs ? `?${qs}` : ''}`),
  });
}

export function useSaveTimeRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/time-records', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-time-records'] }),
  });
}

// ===== PAYSLIPS =====
export function usePayslips(filters?: { employee_id?: string; reference_month?: string }) {
  const params = new URLSearchParams();
  if (filters?.employee_id) params.set('employee_id', filters.employee_id);
  if (filters?.reference_month) params.set('reference_month', filters.reference_month);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-payslips', qs],
    queryFn: () => api<any[]>(`/api/rh/payslips${qs ? `?${qs}` : ''}`),
  });
}

export function useCreatePayslip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/payslips', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-payslips'] }),
  });
}

export function useUpdatePayslip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/rh/payslips/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-payslips'] }),
  });
}

export function useImportPayslip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/payslips/import', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-payslips'] }),
  });
}

export function useBulkMatchPayslips() {
  return useMutation({
    mutationFn: (data: { filenames: string[] }) =>
      api<any>('/api/rh/payslips/bulk-match', { method: 'POST', body: data }),
  });
}

export function useBulkImportPayslips() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      reference_month: string;
      payment_type?: string;
      send_for_signature?: boolean;
      items: Array<{ employee_id: string; pdf_url: string; filename?: string; notes?: string }>;
    }) => api<any>('/api/rh/payslips/bulk-import', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-payslips'] }),
  });
}

// ===== ABSENCES =====
export function useAbsences(employeeId?: string) {
  const params = employeeId ? `?employee_id=${employeeId}` : '';
  return useQuery({
    queryKey: ['rh-absences', employeeId],
    queryFn: () => api<any[]>(`/api/rh/absences${params}`),
  });
}

export function useCreateAbsence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/absences', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-absences'] }),
  });
}

// ===== SUPPORT TABLES =====
export function useBranches() {
  return useQuery({ queryKey: ['rh-branches'], queryFn: () => api<any[]>('/api/rh/branches') });
}
export function useCreateBranch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/branches', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-branches'] }),
  });
}

export function useRhDepartments() {
  return useQuery({ queryKey: ['rh-departments'], queryFn: () => api<any[]>('/api/rh/rh-departments') });
}
export function useCreateRhDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/rh-departments', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-departments'] }),
  });
}
export function useDeleteRhDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/rh/rh-departments/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-departments'] }),
  });
}

// ===== POSITIONS (CARGOS) =====
export function useRhPositions() {
  return useQuery({ queryKey: ['rh-positions'], queryFn: () => api<any[]>('/api/rh/positions') });
}
export function useCreateRhPosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/positions', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-positions'] }),
  });
}
export function useDeleteRhPosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/rh/positions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-positions'] }),
  });
}

export function useDeleteBranch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/rh/branches/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-branches'] }),
  });
}

// ===== WORKER PROFILES (PERFIS FUNCIONAIS) =====
export function useWorkerProfiles() {
  return useQuery({ queryKey: ['rh-worker-profiles'], queryFn: () => api<any[]>('/api/rh/worker-profiles') });
}
export function useCreateWorkerProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/worker-profiles', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-worker-profiles'] }),
  });
}
export function useDeleteWorkerProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/rh/worker-profiles/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-worker-profiles'] }),
  });
}

export function useCostCenters() {
  return useQuery({ queryKey: ['rh-cost-centers'], queryFn: () => api<any[]>('/api/rh/cost-centers') });
}
export function useCreateCostCenter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/cost-centers', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-cost-centers'] }),
  });
}

// ===== APP PUNCHES (from promotor app) =====
export function useAppPunches(filters?: { employee_id?: string; start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters?.employee_id) params.set('employee_id', filters.employee_id);
  if (filters?.start_date) params.set('start_date', filters.start_date);
  if (filters?.end_date) params.set('end_date', filters.end_date);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-app-punches', qs],
    queryFn: () => api<any[]>(`/api/rh/app-punches${qs ? `?${qs}` : ''}`),
  });
}



function invalidatePunches(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['rh-app-punches'] });
  qc.invalidateQueries({ queryKey: ['rh-consolidated-timesheet'] });
  qc.invalidateQueries({ queryKey: ['rh-punch-divergences'] });
}

export function useCreatePunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/app-punches', { method: 'POST', body: data }),
    onSuccess: () => invalidatePunches(qc),
  });
}

export function useUpdatePunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/rh/app-punches/${id}`, { method: 'PATCH', body: data }),
    onSuccess: () => invalidatePunches(qc),
  });
}

export function useDeletePunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<any>(`/api/rh/app-punches/${id}?reason=${encodeURIComponent(reason)}`, { method: 'DELETE' }),
    onSuccess: () => invalidatePunches(qc),
  });
}


// ===== SYNC DIAGNOSTICS =====
export function useSyncDiagnostics() {
  return useQuery({
    queryKey: ['rh-sync-diagnostics'],
    queryFn: () => api<any>('/api/rh/sync-diagnostics'),
    refetchInterval: 15000,
  });
}

// ===== CONSOLIDATED TIMESHEET =====
export function useConsolidatedTimesheet(filters?: { employee_id?: string; start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters?.employee_id) params.set('employee_id', filters.employee_id);
  if (filters?.start_date) params.set('start_date', filters.start_date);
  if (filters?.end_date) params.set('end_date', filters.end_date);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-consolidated-timesheet', qs],
    queryFn: () => api<any[]>(`/api/rh/consolidated-timesheet${qs ? `?${qs}` : ''}`),
  });
}

// ===== PUNCH DIVERGENCES =====
export function usePunchDivergences(filters?: { start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters?.start_date) params.set('start_date', filters.start_date);
  if (filters?.end_date) params.set('end_date', filters.end_date);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-punch-divergences', qs],
    queryFn: () => api<any[]>(`/api/rh/punch-divergences${qs ? `?${qs}` : ''}`),
  });
}

// ===== AUDIT =====

// ===== DASHBOARD =====
export function useRhDashboard() {
  return useQuery({
    queryKey: ['rh-dashboard'],
    queryFn: () => api<any>('/api/rh/dashboard-stats'),
    refetchInterval: 60000,
  });
}

// ===== VACATIONS =====
export function useVacations(filters?: { employee_id?: string; status?: string }) {
  const params = new URLSearchParams();
  if (filters?.employee_id) params.set('employee_id', filters.employee_id);
  if (filters?.status) params.set('status', filters.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-vacations', qs],
    queryFn: () => api<any[]>(`/api/rh/vacations${qs ? `?${qs}` : ''}`),
  });
}

export function useCreateVacation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/vacations', { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rh-vacations'] }); qc.invalidateQueries({ queryKey: ['rh-dashboard'] }); },
  });
}

export function useUpdateVacation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/rh/vacations/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rh-vacations'] }); qc.invalidateQueries({ queryKey: ['rh-dashboard'] }); },
  });
}

// ===== MEDICAL CERTIFICATES =====
export function useMedicalCertificates(filters?: { employee_id?: string; validated?: string }) {
  const params = new URLSearchParams();
  if (filters?.employee_id) params.set('employee_id', filters.employee_id);
  if (filters?.validated !== undefined) params.set('validated', filters.validated);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-medical-certs', qs],
    queryFn: () => api<any[]>(`/api/rh/medical-certificates${qs ? `?${qs}` : ''}`),
  });
}

export function useCreateMedicalCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/medical-certificates', { method: 'POST', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rh-medical-certs'] }); qc.invalidateQueries({ queryKey: ['rh-dashboard'] }); qc.invalidateQueries({ queryKey: ['rh-time-records'] }); },
  });
}

export function useValidateMedicalCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/rh/medical-certificates/${id}/validate`, { method: 'PUT', body: data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rh-medical-certs'] }); qc.invalidateQueries({ queryKey: ['rh-dashboard'] }); },
  });
}

// ===== DOCUMENTS =====
export function useRhDocuments(filters?: { employee_id?: string; doc_type?: string }) {
  const params = new URLSearchParams();
  if (filters?.employee_id) params.set('employee_id', filters.employee_id);
  if (filters?.doc_type) params.set('doc_type', filters.doc_type);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-documents', qs],
    queryFn: () => api<any[]>(`/api/rh/documents${qs ? `?${qs}` : ''}`),
  });
}

export function useCreateRhDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/documents', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-documents'] }),
  });
}

export function useValidateRhDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/rh/documents/${id}/validate`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-documents'] }),
  });
}

export function useDeleteRhDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/rh/documents/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-documents'] }),
  });
}

export function useRhAuditLog(entityType?: string, entityId?: string) {
  const params = new URLSearchParams();
  if (entityType) params.set('entity_type', entityType);
  if (entityId) params.set('entity_id', entityId);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-audit', qs],
    queryFn: () => api<any[]>(`/api/rh/audit-log${qs ? `?${qs}` : ''}`),
  });
}

// ===== HOLIDAYS =====
export function useHolidays(filters?: { year?: string; type?: string }) {
  const params = new URLSearchParams();
  if (filters?.year) params.set('year', filters.year);
  if (filters?.type) params.set('type', filters.type);
  const qs = params.toString();
  return useQuery({
    queryKey: ['rh-holidays', qs],
    queryFn: () => api<any[]>(`/api/rh/holidays${qs ? `?${qs}` : ''}`),
  });
}

export function useCreateHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/holidays', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-holidays'] }),
  });
}

export function useUpdateHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => api<any>(`/api/rh/holidays/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-holidays'] }),
  });
}

export function useBulkImportHolidays() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (holidays: any[]) => api<any>('/api/rh/holidays/bulk', { method: 'POST', body: { holidays } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-holidays'] }),
  });
}

export function useDeleteHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/rh/holidays/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-holidays'] }),
  });
}

// ===== SERVICE REGIONS =====
export function useServiceRegions() {
  return useQuery({
    queryKey: ['rh-regions'],
    queryFn: () => api<any[]>('/api/rh/regions'),
  });
}

export function useCreateRegion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api<any>('/api/rh/regions', { method: 'POST', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-regions'] }),
  });
}

export function useUpdateRegion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: any) => api<any>(`/api/rh/regions/${id}`, { method: 'PUT', body: data }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-regions'] }),
  });
}

export function useDeleteRegion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<any>(`/api/rh/regions/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-regions'] }),
  });
}

export function useLinkPDVsToRegion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ regionId, pdv_ids }: { regionId: string; pdv_ids: string[] }) =>
      api<any>(`/api/rh/regions/${regionId}/pdvs`, { method: 'POST', body: { pdv_ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-regions'] }),
  });
}

export function useRegionPDVs(regionId?: string) {
  return useQuery({
    queryKey: ['rh-region-pdvs', regionId],
    queryFn: () => api<any[]>(`/api/rh/regions/${regionId}/pdvs`),
    enabled: !!regionId,
  });
}

// ===== GEOCODING =====
export function useGeocode() {
  return useMutation({
    mutationFn: (data: { address?: string; address_number?: string; complement?: string; neighborhood?: string; city?: string; state?: string; zip_code?: string }) =>
      api<any>('/api/rh/geocode', { method: 'POST', body: data }),
  });
}

// ===== MAP DATA =====
export function useRhMapData() {
  return useQuery({
    queryKey: ['rh-map-data'],
    queryFn: () => api<any>('/api/rh/map-data'),
  });
}

// ===== MONITORING & LOGS =====
export function useRhRuntimeLogs(filters: { level?: string; limit?: number; event_prefix?: string } = {}) {
  const queryParams = new URLSearchParams();
  if (filters.level && filters.level !== 'all') queryParams.append('level', filters.level);
  if (filters.limit) queryParams.append('limit', filters.limit.toString());
  if (filters.event_prefix) queryParams.append('event_prefix', filters.event_prefix);

  return useQuery({
    queryKey: ['rh-runtime-logs', filters],
    queryFn: () => api<any[]>(`/api/rh/runtime-logs?${queryParams.toString()}`),
    refetchInterval: 5000,
  });
}

export function useRhConnectedDevices() {
  return useQuery({
    queryKey: ['rh-connected-devices'],
    queryFn: () => api<any[]>('/api/rh/connected-devices'),
    refetchInterval: 30000,
  });
}
