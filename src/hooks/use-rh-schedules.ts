import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useSchedules() {
  return useQuery({ queryKey: ['rh-schedules'], queryFn: () => api<any[]>('/api/rh/schedules') });
}
export function useSaveSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: any) =>
      id ? api(`/api/rh/schedules/${id}`, { method: 'PUT', body })
         : api('/api/rh/schedules', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-schedules'] }),
  });
}
export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/rh/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-schedules'] }),
  });
}
export function useScheduleAssignments(scheduleId?: string) {
  return useQuery({
    queryKey: ['rh-schedule-assignments', scheduleId],
    queryFn: () => api<any[]>(`/api/rh/schedules/${scheduleId}/assignments`),
    enabled: !!scheduleId,
  });
}
export function useAssignSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: any) => api('/api/rh/employee-schedules', { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rh-schedule-assignments'] });
      qc.invalidateQueries({ queryKey: ['rh-employee-schedule'] });
    },
  });
}
export function useRemoveAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/rh/employee-schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rh-schedule-assignments'] });
      // A remoção altera a escala exibida no cadastro do colaborador.
      // Invalide o prefixo para atualizar qualquer funcionário aberto no momento.
      qc.invalidateQueries({ queryKey: ['rh-employee-schedule'] });
    },
  });
}

export function useEmployeeSchedule(employeeId?: string) {
  return useQuery({
    queryKey: ['rh-employee-schedule', employeeId],
    queryFn: () => api<any>(`/api/rh/employees/${employeeId}/schedule`),
    enabled: !!employeeId,
  });
}

export function useTotemDevices() {
  return useQuery({ queryKey: ['rh-totem-devices'], queryFn: () => api<any[]>('/api/rh/totem-devices') });
}
export function useCreateTotemDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: any) => api('/api/rh/totem-devices', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-totem-devices'] }),
  });
}
export function useDeleteTotemDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/rh/totem-devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rh-totem-devices'] }),
  });
}
