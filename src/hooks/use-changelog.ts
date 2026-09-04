import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type ChangelogType = "bug" | "melhoria";

export interface ChangelogEntry {
  id: string;
  entry_date: string;
  type: ChangelogType;
  area: string | null;
  title: string;
  problem_text: string | null;
  solution_text: string | null;
  ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChangelogFilters {
  type?: string;
  area?: string;
  q?: string;
  date_from?: string;
  date_to?: string;
}

export type ChangelogEntryInput = Partial<
  Pick<ChangelogEntry, "entry_date" | "type" | "area" | "title" | "problem_text" | "solution_text" | "ref">
>;

function buildQuery(filters: ChangelogFilters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v) params.set(k, v);
  });
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function useChangelog(filters: ChangelogFilters = {}) {
  return useQuery({
    queryKey: ["changelog", filters],
    queryFn: () => api<ChangelogEntry[]>(`/api/rh/changelog${buildQuery(filters)}`),
  });
}

export function useChangelogAreas() {
  return useQuery({
    queryKey: ["changelog-areas"],
    queryFn: () => api<string[]>("/api/rh/changelog/areas"),
  });
}

export function useCreateChangelogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ChangelogEntryInput) =>
      api<ChangelogEntry>("/api/rh/changelog", { method: "POST", body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["changelog"] });
      qc.invalidateQueries({ queryKey: ["changelog-areas"] });
    },
  });
}

export function useUpdateChangelogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: ChangelogEntryInput & { id: string }) =>
      api<ChangelogEntry>(`/api/rh/changelog/${id}`, { method: "PUT", body: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["changelog"] });
      qc.invalidateQueries({ queryKey: ["changelog-areas"] });
    },
  });
}

export function useDeleteChangelogEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/rh/changelog/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["changelog"] }),
  });
}
