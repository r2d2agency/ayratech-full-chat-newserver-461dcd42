import React, { useState, useCallback, useMemo, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { MainLayout } from "@/components/layout/MainLayout";
import { useEmployees, useCreateEmployee, useUpdateEmployee, useDeleteEmployee, useRhDepartments, useBranches, useCreateBranch, useDeleteBranch, useCreateRhDepartment, useDeleteRhDepartment, useRhPositions, useCreateRhPosition, useDeleteRhPosition, useWorkerProfiles, useCreateWorkerProfile, useDeleteWorkerProfile, useRhDocuments, useCreateRhDocument, useDeleteRhDocument, useSyncEmployeeSchedule } from "@/hooks/use-rh";
import { useSchedules, useEmployeeSchedule, useAssignSchedule } from "@/hooks/use-rh-schedules";
import { usePDVs, useAppAccess, useGrantAppAccess, useBlockAppAccess, useResetAppPassword } from "@/hooks/use-promotor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Plus, Search, UserCircle, Building2, FileText, Edit, Trash2, Eye, EyeOff, Users, Loader2, Calendar, Briefcase, X, MapPin, UserCog, DollarSign, Gift, Smartphone, KeyRound, Copy, RefreshCw, FileSpreadsheet, UserPlus, UserMinus, Link2, CalendarDays } from "lucide-react";
import { EmployeeImportExportDialog } from "@/components/rh/EmployeeImportExportDialog";
import { EmployeeOnboardingLinkDialog } from "@/components/rh/EmployeeOnboardingLinkDialog";
import { useUpload } from "@/hooks/use-upload";
import { format, differenceInYears, differenceInMonths, differenceInDays, addYears, addMonths } from "date-fns";
import { ptBR } from "date-fns/locale";

const STATUS_COLORS: Record<string, string> = {
  ativo: "bg-green-500/10 text-green-700 border-green-200",
  afastado: "bg-yellow-500/10 text-yellow-700 border-yellow-200",
  ferias: "bg-blue-500/10 text-blue-700 border-blue-200",
  desligado: "bg-red-500/10 text-red-700 border-red-200",
  suspenso: "bg-orange-500/10 text-orange-700 border-orange-200",
};

const EMPLOYMENT_LABELS: Record<string, string> = {
  clt: "CLT", pj: "PJ", freelancer: "Freelancer", temporario: "Temporário", estagiario: "Estagiário", aprendiz: "Aprendiz",
};

const PROFILE_LABELS: Record<string, string> = {
  administrativo: "Administrativo", supervisor: "Supervisor", promotor: "Promotor", operacional: "Operacional",
};

const SALARY_ITEM_TYPES = [
  "Salário Base", "Adicional Noturno", "Adicional Periculosidade", "Adicional Insalubridade",
  "Comissão", "Gratificação", "Hora Extra", "DSR", "Adicional de Função", "Bonificação", "Outro"
];

const BENEFIT_TYPES = [
  "Vale Transporte", "Vale Refeição", "Vale Alimentação", "Plano de Saúde", "Plano Odontológico",
  "Seguro de Vida", "Auxílio Creche", "Auxílio Educação", "Gympass/Wellhub", "PLR",
  "Cesta Básica", "Auxílio Home Office", "Outro"
];

const WEEKDAYS = [
  { key: "seg", label: "Seg" },
  { key: "ter", label: "Ter" },
  { key: "qua", label: "Qua" },
  { key: "qui", label: "Qui" },
  { key: "sex", label: "Sex" },
  { key: "sab", label: "Sáb" },
  { key: "dom", label: "Dom" },
];

const DEFAULT_SCHEDULE = {
  days: { seg: true, ter: true, qua: true, qui: true, sex: true, sab: false, dom: false },
  dayConfig: {
    seg: { entry: "08:00", exit: "17:00", lunch_start: "12:00", lunch_end: "13:00" },
    ter: { entry: "08:00", exit: "17:00", lunch_start: "12:00", lunch_end: "13:00" },
    qua: { entry: "08:00", exit: "17:00", lunch_start: "12:00", lunch_end: "13:00" },
    qui: { entry: "08:00", exit: "17:00", lunch_start: "12:00", lunch_end: "13:00" },
    sex: { entry: "08:00", exit: "17:00", lunch_start: "12:00", lunch_end: "13:00" },
    sab: { entry: "08:00", exit: "12:00", lunch_start: "", lunch_end: "" },
    dom: { entry: "08:00", exit: "12:00", lunch_start: "", lunch_end: "" },
  },
  entry: "08:00",
  exit: "17:00",
  lunch_start: "12:00",
  lunch_end: "13:00",
  useIndividualDays: false,
};

function parseSchedule(ws: any) {
  if (!ws) return { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days } };
  if (typeof ws === "object" && ws.days) return ws;
  // Legacy "08:00-17:00" format
  const match = typeof ws === "string" && ws.match(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
  if (match) return { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days }, entry: match[1], exit: match[2] };
  try { return JSON.parse(ws); } catch { return { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days } }; }
}

function calcScheduleHours(sched: any) {
  const workDaysList = Object.entries(sched.days).filter(([_, v]) => v).map(([k]) => k);
  const workDaysCount = workDaysList.length;
  
  let totalDailyHours = 0;
  
  if (sched.useIndividualDays && sched.dayConfig) {
    workDaysList.forEach(day => {
      const config = sched.dayConfig[day];
      if (!config || !config.entry || !config.exit) return;
      
      const [eh, em] = config.entry.split(":").map(Number);
      const [xh, xm] = config.exit.split(":").map(Number);
      let totalMin = (xh * 60 + xm) - (eh * 60 + em);
      
      // Se não houver intervalo configurado, não subtraímos nada
      if (config.lunch_start && config.lunch_end && config.lunch_start !== "" && config.lunch_end !== "") {
        const [lsh, lsm] = config.lunch_start.split(":").map(Number);
        const [leh, lem] = config.lunch_end.split(":").map(Number);
        const lunchMin = (leh * 60 + lem) - (lsh * 60 + lsm);
        totalMin -= Math.max(0, lunchMin);
      }
      
      totalDailyHours += Math.max(0, totalMin) / 60;
    });
  } else {
    const [eh, em] = (sched.entry || "08:00").split(":").map(Number);
    const [xh, xm] = (sched.exit || "17:00").split(":").map(Number);
    const [lsh, lsm] = (sched.lunch_start || "12:00").split(":").map(Number);
    const [leh, lem] = (sched.lunch_end || "13:00").split(":").map(Number);
    
    const totalMin = (xh * 60 + xm) - (eh * 60 + em);
    const hasLunch = sched.lunch_start && sched.lunch_end && sched.lunch_start !== "" && sched.lunch_end !== "";
    const lunchMin = hasLunch ? (leh * 60 + lem) - (lsh * 60 + lsm) : 0;
    const dailyHours = Math.max(0, totalMin - lunchMin) / 60;
    totalDailyHours = dailyHours * workDaysCount;
  }

  const avgDailyHours = workDaysCount > 0 ? totalDailyHours / workDaysCount : 0;
  const monthlyWorkDays = Math.round(workDaysCount * 4.33);
  const monthlyHours = avgDailyHours * monthlyWorkDays;
  
  return { dailyHours: avgDailyHours, totalWeeklyHours: totalDailyHours, workDays: workDaysCount, monthlyWorkDays, monthlyHours };
}

const EMPTY_FORM = {
  full_name: "", social_name: "", cpf: "", rg: "", birth_date: "", gender: "", email: "", phone: "",
  address: "", address_number: "", complement: "", neighborhood: "", city: "", state: "", zip_code: "",
  registration_number: "",
  worker_profile: "operacional", employment_type: "clt", position: "", salary: "",
  admission_date: "", department_id: "", branch_id: "", direct_manager_id: "",
  work_schedule: { ...DEFAULT_SCHEDULE, days: { ...DEFAULT_SCHEDULE.days } },
  bank_name: "", bank_agency: "", bank_account: "", bank_account_type: "", pix_key: "", pix_key_type: "",
  ctps_number: "", pis_pasep: "", cnpj: "", company_name: "", status: "ativo",
  facial_required: null as boolean | null,
  punch_tolerance_minutes: null as number | null,
  punch_requires_checkin: false as boolean | null,
  punch_without_active_route: false as boolean | null,
  salary_items: [] as { type: string; description: string; value: string }[],

  benefits: [] as { type: string; description: string; value: string; employer_cost: string }[],
};

function extractApiErrorMessage(error: any) {
  return error?.message || error?.response?.error || error?.response?.details || "Erro ao salvar";
}

function buildCreateEmployeePayload(form: any) {
  const payload = {
    full_name: form.full_name?.trim(),
    social_name: form.social_name || undefined,
    cpf: form.cpf || undefined,
    rg: form.rg || undefined,
    birth_date: form.birth_date || undefined,
    gender: form.gender || undefined,
    email: form.email || undefined,
    phone: form.phone || undefined,
    address: form.address || undefined,
    address_number: form.address_number || undefined,
    complement: form.complement || undefined,
    neighborhood: form.neighborhood || undefined,
    city: form.city || undefined,
    state: form.state || undefined,
    zip_code: form.zip_code || undefined,
    registration_number: form.registration_number || undefined,
    worker_profile: form.worker_profile || "operacional",
    employment_type: form.employment_type || "clt",
    position: form.position || undefined,
    salary: form.salary || undefined,
    department_id: form.department_id || undefined,
    branch_id: form.branch_id || undefined,
    direct_manager_id: form.direct_manager_id || undefined,
    admission_date: form.admission_date || undefined,
    work_schedule: form.work_schedule,
    bank_name: form.bank_name || undefined,
    bank_agency: form.bank_agency || undefined,
    bank_account: form.bank_account || undefined,
    bank_account_type: form.bank_account_type || undefined,
    pix_key: form.pix_key || undefined,
    pix_key_type: form.pix_key_type || undefined,
    ctps_number: form.ctps_number || undefined,
    pis_pasep: form.pis_pasep || undefined,
    cnpj: form.cnpj || undefined,
    company_name: form.company_name || undefined,
    status: form.status || "ativo",
    facial_required: form.facial_required,
    punch_tolerance_minutes: form.punch_tolerance_minutes ?? undefined,
    punch_requires_checkin: form.punch_requires_checkin,
    punch_without_active_route: form.punch_without_active_route,
    salary_items: Array.isArray(form.salary_items) ? form.salary_items : [],
    benefits: Array.isArray(form.benefits) ? form.benefits : [],
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  });

  return payload;
}

// ============ CPF Validation ============
function validateCPF(cpf: string): boolean {
  const cleaned = cpf.replace(/\D/g, "");
  if (cleaned.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cleaned)) return false; // all same digits
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cleaned[i]) * (10 - i);
  let remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  if (remainder !== parseInt(cleaned[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cleaned[i]) * (11 - i);
  remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  return remainder === parseInt(cleaned[10]);
}

function formatCPF(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function formatCEP(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 5) return digits;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

// ============ Age Calculation ============
function calcAge(birthDate: string): string {
  if (!birthDate) return "";
  const birth = new Date(birthDate + "T00:00:00");
  const today = new Date();
  const years = differenceInYears(today, birth);
  const afterYears = addYears(birth, years);
  const months = differenceInMonths(today, afterYears);
  const afterMonths = addMonths(afterYears, months);
  const days = differenceInDays(today, afterMonths);
  return `${years} anos, ${months} meses e ${days} dias`;
}

export default function RHColaboradores() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [profileFilter, setProfileFilter] = useState("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [onboardingTarget, setOnboardingTarget] = useState<{ id: string | null; name: string | null } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<any>({ ...EMPTY_FORM });
  const [showSensitive, setShowSensitive] = useState(false);
  const [showAdvancedTabs, setShowAdvancedTabs] = useState(false);
  const [cpfError, setCpfError] = useState("");
  const [cepLoading, setCepLoading] = useState(false);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const { toast } = useToast();

  const { data: rawEmployees = [], isLoading } = useEmployees({
    search: search || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
  });

  const { data: allEmployeesForSupervisor = [] } = useEmployees({});

  const employees = useMemo(() => {
    if (profileFilter === "all") return rawEmployees;
    if (profileFilter === "promotor_access") return rawEmployees.filter((e: any) => e.promotor_access);
    return rawEmployees.filter((e: any) => e.worker_profile === profileFilter);
  }, [rawEmployees, profileFilter]);
  const { data: departments = [] } = useRhDepartments();
  const { data: allBranches = [] } = usePDVs(); // Usando PDVs & Sedes unificados
  const branches = useMemo(() => {
    // Show all 'sede' types, but also 'pdv' if they are assigned to this employee (for backward compatibility if needed)
    return allBranches.filter((b: any) => b.type === 'sede' || b.id === form.branch_id);
  }, [allBranches, form.branch_id]);
  const { data: positions = [] } = useRhPositions();
  const { data: workerProfiles = [] } = useWorkerProfiles();
  const { data: schedules = [] } = useSchedules();
  const { data: currentSchedule } = useEmployeeSchedule(editId || undefined);
  const assignScheduleMut = useAssignSchedule();
  const [scheduleId, setScheduleId] = useState<string>("");
  useEffect(() => { setScheduleId(currentSchedule?.schedule_id || ""); }, [currentSchedule?.schedule_id, editId]);
  const createMut = useCreateEmployee();
  const updateMut = useUpdateEmployee();
  const deleteMut = useDeleteEmployee();
  const syncScheduleMut = useSyncEmployeeSchedule();
  const createDeptMut = useCreateRhDepartment();
  const deleteDeptMut = useDeleteRhDepartment();
  const createPosMut = useCreateRhPosition();
  const deletePosMut = useDeleteRhPosition();
  const createBranchMut = useCreateBranch();
  const deleteBranchMut = useDeleteBranch();
  const createProfileMut = useCreateWorkerProfile();
  const deleteProfileMut = useDeleteWorkerProfile();

  const [newDeptName, setNewDeptName] = useState("");
  const [newPosName, setNewPosName] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [showDeptManager, setShowDeptManager] = useState(false);
  const [showPosManager, setShowPosManager] = useState(false);
  const [showBranchManager, setShowBranchManager] = useState(false);
  const [showProfileManager, setShowProfileManager] = useState(false);

  const maskCPF = (cpf: string) => {
    if (!cpf) return "—";
    if (showSensitive) return cpf;
    return cpf.replace(/(\d{3})\.\d{3}\.\d{3}(-\d{2})/, "$1.***.***$2");
  };

  // ============ CEP Lookup ============
  const lookupCEP = useCallback(async (cep: string) => {
    const digits = cep.replace(/\D/g, "");
    if (digits.length !== 8) return;
    setCepLoading(true);
    try {
      const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
      const data = await res.json();
      if (!data.erro) {
        setForm((p: any) => ({
          ...p,
          address: data.logradouro || p.address,
          neighborhood: data.bairro || p.neighborhood,
          city: data.localidade || p.city,
          state: data.uf || p.state,
          complement: data.complemento || p.complement,
        }));
        toast({ title: "Endereço preenchido automaticamente!" });
      } else {
        toast({ title: "CEP não encontrado", variant: "destructive" });
      }
    } catch {
      toast({ title: "Erro ao buscar CEP", variant: "destructive" });
    } finally {
      setCepLoading(false);
    }
  }, [toast]);

  // ============ CPF handler ============
  const handleCPFChange = (value: string) => {
    const formatted = formatCPF(value);
    setField("cpf", formatted);
    const digits = value.replace(/\D/g, "");
    if (digits.length === 11) {
      if (!validateCPF(digits)) {
        setCpfError("CPF inválido");
      } else {
        setCpfError("");
      }
    } else {
      setCpfError("");
    }
  };

  const openNew = () => {
    setForm({ ...EMPTY_FORM });
    setEditId(null);
    setShowAdvancedTabs(false);
    setCpfError("");
    setDialogOpen(true);
  };
  const openEdit = (emp: any) => {
    setForm({
      ...emp,
      salary: emp.salary || "",
      birth_date: emp.birth_date?.slice(0, 10) || "",
      admission_date: emp.admission_date?.slice(0, 10) || "",
      work_schedule: parseSchedule(emp.work_schedule),
      salary_items: emp.salary_items || [],
      benefits: emp.benefits || [],
    });
    setEditId(emp.id);
    setShowAdvancedTabs(true);
    setCpfError("");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.full_name) { toast({ title: "Nome é obrigatório", variant: "destructive" }); return; }
    if (cpfError) { toast({ title: "CPF inválido, corrija antes de salvar", variant: "destructive" }); return; }
    try {
      if (editId) {
        await updateMut.mutateAsync({ id: editId, ...form });
        toast({ title: "Colaborador atualizado!" });
      } else {
        await createMut.mutateAsync(buildCreateEmployeePayload(form));
        toast({ title: "Colaborador cadastrado!" });
      }
      setDialogOpen(false);
    } catch (error: any) {
      toast({ title: "Erro ao salvar", description: extractApiErrorMessage(error), variant: "destructive" });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Deseja desligar este colaborador?")) return;
    await deleteMut.mutateAsync(id);
    toast({ title: "Colaborador desligado" });
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!confirm(`ATENÇÃO: Apagar PERMANENTEMENTE ${selectedIds.length} colaboradores selecionados? Esta ação não pode ser desfeita.`)) return;
    
    try {
      await Promise.all(selectedIds.map(id => deleteMut.mutateAsync({ id, hard: true })));
      toast({ title: `${selectedIds.length} colaboradores apagados com sucesso` });
      setSelectedIds([]);
    } catch (error) {
      toast({ title: "Erro ao apagar alguns colaboradores", variant: "destructive" });
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === employees.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(employees.map((e: any) => e.id));
    }
  };

  const setField = (key: string, val: any) => setForm((p: any) => ({ ...p, [key]: val }));

  const stats = {
    total: employees.length,
    ativos: employees.filter((e: any) => e.status === "ativo").length,
    afastados: employees.filter((e: any) => e.status === "afastado" || e.status === "ferias").length,
    desligados: employees.filter((e: any) => e.status === "desligado").length,
  };

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2"><Users className="h-6 w-6 text-primary" /> Colaboradores</h1>
            <p className="text-sm text-muted-foreground">Gestão de pessoas e fichas cadastrais</p>
          </div>
          <div className="flex gap-2">
            {selectedIds.length > 0 && (
              <Button variant="destructive" onClick={handleBulkDelete} className="gap-2">
                <Trash2 className="h-4 w-4" /> Apagar Permanentemente ({selectedIds.length})
              </Button>
            )}
            <Button variant="outline" onClick={() => setImportExportOpen(true)} className="gap-2"><FileSpreadsheet className="h-4 w-4" /> Importar / Exportar</Button>
            <Button variant="outline" onClick={() => setOnboardingTarget({ id: null, name: null })} className="gap-2"><Link2 className="h-4 w-4" /> Link de Auto-Cadastro</Button>
            <Button variant="outline" onClick={() => navigate("/rh/admissao")} className="gap-2"><UserPlus className="h-4 w-4" /> Nova Admissão (Wizard)</Button>
            <Button onClick={openNew} className="gap-2"><Plus className="h-4 w-4" /> Novo Colaborador</Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Total", value: stats.total, color: "text-foreground" },
            { label: "Ativos", value: stats.ativos, color: "text-green-600" },
            { label: "Afastados", value: stats.afastados, color: "text-yellow-600" },
            { label: "Desligados", value: stats.desligados, color: "text-red-600" },
          ].map(s => (
            <Card key={s.label}>
              <CardContent className="p-4 text-center">
                <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Buscar por nome, CPF ou e-mail..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="ativo">Ativo</SelectItem>
              <SelectItem value="afastado">Afastado</SelectItem>
              <SelectItem value="ferias">Férias</SelectItem>
              <SelectItem value="desligado">Desligado</SelectItem>
            </SelectContent>
          </Select>
          <Select value={profileFilter} onValueChange={setProfileFilter}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos Perfis</SelectItem>
              <SelectItem value="promotor">Promotor</SelectItem>
              <SelectItem value="promotor_access">Com Acesso App</SelectItem>
              <SelectItem value="administrativo">Administrativo</SelectItem>
              <SelectItem value="supervisor">Supervisor</SelectItem>
              <SelectItem value="operacional">Operacional</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => setShowSensitive(!showSensitive)} title={showSensitive ? "Ocultar dados sensíveis" : "Mostrar dados sensíveis"}>
            {showSensitive ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox 
                      checked={selectedIds.length === employees.length && employees.length > 0} 
                      onCheckedChange={toggleSelectAll}
                    />
                  </TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead className="hidden md:table-cell">CPF</TableHead>
                  <TableHead className="hidden md:table-cell">Cargo</TableHead>
                  <TableHead className="hidden lg:table-cell">Vínculo</TableHead>
                  <TableHead className="hidden lg:table-cell">Departamento</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Carregando...</TableCell></TableRow>
                ) : employees.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Nenhum colaborador encontrado</TableCell></TableRow>
                ) : employees.map((emp: any) => (
                  <TableRow key={emp.id} className="cursor-pointer hover:bg-muted/50" onClick={() => openEdit(emp)}>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox 
                        checked={selectedIds.includes(emp.id)} 
                        onCheckedChange={() => toggleSelect(emp.id)} 
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <UserCircle className="h-8 w-8 text-muted-foreground" />
                        <div>
                          <p className="font-medium">{emp.full_name}</p>
                          <p className="text-xs text-muted-foreground">{emp.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm">{maskCPF(emp.cpf)}</TableCell>
                    <TableCell className="hidden md:table-cell text-sm">{emp.position || "—"}</TableCell>
                    <TableCell className="hidden lg:table-cell"><Badge variant="outline" className="text-xs">{EMPLOYMENT_LABELS[emp.employment_type] || emp.employment_type}</Badge></TableCell>
                    <TableCell className="hidden lg:table-cell text-sm">{emp.department_name || "—"}</TableCell>
                    <TableCell><Badge className={STATUS_COLORS[emp.status] || ""}>{emp.status}</Badge></TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={e => { e.stopPropagation(); openEdit(emp); }}><Edit className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" title="Gerar link de auto-cadastro" onClick={e => { e.stopPropagation(); setOnboardingTarget({ id: emp.id, name: emp.full_name }); }}><Link2 className="h-4 w-4 text-primary" /></Button>
                        {emp.status !== 'desligado' && (
                          <Button variant="ghost" size="icon" title="Demitir" onClick={e => { e.stopPropagation(); navigate(`/rh/demissao/${emp.id}`); }}><UserMinus className="h-4 w-4 text-orange-600" /></Button>
                        )}
                        <Button variant="ghost" size="icon" onClick={e => { e.stopPropagation(); handleDelete(emp.id); }}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Employee Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId ? "Editar Colaborador" : "Novo Colaborador"}</DialogTitle>
            {/* Age display when editing and has birth_date */}
            {form.birth_date && (
              <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span>Idade: <strong className="text-foreground">{calcAge(form.birth_date)}</strong></span>
              </div>
            )}
          </DialogHeader>
          {!editId && (
            <div className="mt-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-medium">Cadastro rapido</p>
              <p className="text-muted-foreground">
                Preencha so o basico para liberar o colaborador. Os dados de remuneracao, documentos e banco podem ser completados depois.
              </p>
            </div>
          )}
          <Tabs defaultValue="pessoal">
            <div className="flex items-center gap-2">
              <TabsList className={`grid w-full ${editId || showAdvancedTabs ? "grid-cols-5" : "grid-cols-2"}`}>
              <TabsTrigger value="pessoal">Pessoal</TabsTrigger>
              <TabsTrigger value="profissional">Profissional</TabsTrigger>
              {(editId || showAdvancedTabs) && (
                <>
                  <TabsTrigger value="remuneracao" className="gap-1"><DollarSign className="h-3 w-3" />Remuneração</TabsTrigger>
                  <TabsTrigger value="documentos">Documentos</TabsTrigger>
                  <TabsTrigger value="bancario">Bancário</TabsTrigger>
                </>
              )}
              </TabsList>
              {!editId && !showAdvancedTabs && (
                <Button type="button" variant="outline" size="sm" onClick={() => setShowAdvancedTabs(true)}>
                  Cadastro completo
                </Button>
              )}
            </div>

            <TabsContent value="pessoal" className="space-y-3 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div><Label>Nome Completo *</Label><Input value={form.full_name} onChange={e => setField("full_name", e.target.value)} /></div>
                {(editId || showAdvancedTabs) && <div><Label>Nome Social</Label><Input value={form.social_name} onChange={e => setField("social_name", e.target.value)} /></div>}
                <div>
                  <Label>CPF</Label>
                  <Input
                    value={form.cpf}
                    onChange={e => handleCPFChange(e.target.value)}
                    placeholder="000.000.000-00"
                    maxLength={14}
                    className={cpfError ? "border-destructive" : ""}
                  />
                  {cpfError && <p className="text-xs text-destructive mt-1">{cpfError}</p>}
                </div>
                {(editId || showAdvancedTabs) && <div><Label>RG</Label><Input value={form.rg} onChange={e => setField("rg", e.target.value)} /></div>}
                {(editId || showAdvancedTabs) && (
                  <div>
                    <Label>Data de Nascimento</Label>
                    <Input type="date" value={form.birth_date} onChange={e => setField("birth_date", e.target.value)} />
                    {form.birth_date && (
                      <p className="text-xs text-muted-foreground mt-1">{calcAge(form.birth_date)}</p>
                    )}
                  </div>
                )}
                {(editId || showAdvancedTabs) && <div><Label>Gênero</Label>
                  <Select value={form.gender} onValueChange={v => setField("gender", v)}>
                    <SelectTrigger><SelectValue placeholder="Selecionar" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="masculino">Masculino</SelectItem>
                      <SelectItem value="feminino">Feminino</SelectItem>
                      <SelectItem value="outro">Outro</SelectItem>
                      <SelectItem value="nao_informar">Prefiro não informar</SelectItem>
                    </SelectContent>
                  </Select>
                </div>}
                <div><Label>E-mail</Label><Input type="email" value={form.email} onChange={e => setField("email", e.target.value)} /></div>
                <div><Label>Telefone</Label><Input placeholder="(00) 00000-0000" value={form.phone} onChange={e => {
                  let v = e.target.value.replace(/\D/g, "").slice(0, 11);
                  if (v.length > 6) v = `(${v.slice(0,2)}) ${v.slice(2,7)}-${v.slice(7)}`;
                  else if (v.length > 2) v = `(${v.slice(0,2)}) ${v.slice(2)}`;
                  else if (v.length > 0) v = `(${v}`;
                  setField("phone", v);
                }} /></div>
              </div>

              {(editId || showAdvancedTabs) && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <Label>CEP</Label>
                    <div className="relative">
                      <Input
                        value={form.zip_code}
                        onChange={e => {
                          const formatted = formatCEP(e.target.value);
                          setField("zip_code", formatted);
                          if (formatted.replace(/\D/g, "").length === 8) {
                            lookupCEP(formatted);
                          }
                        }}
                        placeholder="00000-000"
                        maxLength={9}
                      />
                      {cepLoading && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
                    </div>
                  </div>
                  <div className="md:col-span-2"><Label>Endereço</Label><Input value={form.address} onChange={e => setField("address", e.target.value)} /></div>
                  <div><Label>Número</Label><Input value={form.address_number} onChange={e => setField("address_number", e.target.value)} /></div>
                  <div><Label>Complemento</Label><Input value={form.complement} onChange={e => setField("complement", e.target.value)} /></div>
                  <div><Label>Bairro</Label><Input value={form.neighborhood} onChange={e => setField("neighborhood", e.target.value)} /></div>
                  <div><Label>Cidade</Label><Input value={form.city} onChange={e => setField("city", e.target.value)} /></div>
                  <div><Label>Estado</Label><Input value={form.state} onChange={e => setField("state", e.target.value)} maxLength={2} /></div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="profissional" className="space-y-3 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Matrícula</Label>
                  <Input value={form.registration_number} onChange={e => setField("registration_number", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Tolerância para Ponto (min)</Label>
                  <Input 
                    type="number" 
                    placeholder="Padrão da organização"
                    value={form.punch_tolerance_minutes || ""} 
                    onChange={e => setField("punch_tolerance_minutes", e.target.value ? parseInt(e.target.value) : null)} 
                  />
                  <p className="text-[10px] text-muted-foreground">Deixe vazio para usar a configuração global.</p>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <Label>Cargo</Label>
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs gap-1" onClick={() => setShowPosManager(!showPosManager)}>
                      <Briefcase className="h-3 w-3" /> Gerenciar
                    </Button>
                  </div>
                  <Select value={form.position || ""} onValueChange={v => setField("position", v)}>
                    <SelectTrigger><SelectValue placeholder="Selecionar cargo" /></SelectTrigger>
                    <SelectContent>
                      {positions.map((p: any) => <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>)}
                      {positions.length === 0 && <p className="text-xs text-muted-foreground text-center py-2">Nenhum cargo cadastrado</p>}
                    </SelectContent>
                  </Select>
                  {showPosManager && (
                    <div className="mt-2 p-3 border rounded-lg bg-muted/30 space-y-2">
                      <p className="text-xs font-medium">Cargos cadastrados:</p>
                      <div className="flex flex-wrap gap-1">
                        {positions.map((p: any) => (
                          <Badge key={p.id} variant="secondary" className="gap-1 pr-1">
                            {p.name}
                            <button onClick={() => deletePosMut.mutate(p.id)} className="ml-1 hover:text-destructive"><X className="h-3 w-3" /></button>
                          </Badge>
                        ))}
                      </div>
                      <div className="flex gap-1">
                        <Input value={newPosName} onChange={e => setNewPosName(e.target.value)} placeholder="Novo cargo..." className="h-8 text-sm" />
                        <Button size="sm" className="h-8 shrink-0" disabled={!newPosName.trim() || createPosMut.isPending}
                          onClick={async () => { await createPosMut.mutateAsync({ name: newPosName.trim() }); setNewPosName(""); }}>
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <Label>Perfil Funcional</Label>
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs gap-1" onClick={() => setShowProfileManager(!showProfileManager)}>
                      <UserCog className="h-3 w-3" /> Gerenciar
                    </Button>
                  </div>
                  <Select value={form.worker_profile || ""} onValueChange={v => setField("worker_profile", v)}>
                    <SelectTrigger><SelectValue placeholder="Selecionar perfil" /></SelectTrigger>
                    <SelectContent>
                      {/* Default profiles */}
                      {Object.entries(PROFILE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                      {/* Custom profiles */}
                      {workerProfiles.filter((p: any) => !Object.keys(PROFILE_LABELS).includes(p.name)).map((p: any) => (
                        <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {showProfileManager && (
                    <div className="mt-2 p-3 border rounded-lg bg-muted/30 space-y-2">
                      <p className="text-xs font-medium">Perfis cadastrados:</p>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(PROFILE_LABELS).map(([k, v]) => (
                          <Badge key={k} variant="outline" className="gap-1">{v}</Badge>
                        ))}
                        {workerProfiles.map((p: any) => (
                          <Badge key={p.id} variant="secondary" className="gap-1 pr-1">
                            {p.name}
                            <button onClick={() => deleteProfileMut.mutate(p.id)} className="ml-1 hover:text-destructive"><X className="h-3 w-3" /></button>
                          </Badge>
                        ))}
                      </div>
                      <div className="flex gap-1">
                        <Input value={newProfileName} onChange={e => setNewProfileName(e.target.value)} placeholder="Novo perfil..." className="h-8 text-sm" />
                        <Button size="sm" className="h-8 shrink-0" disabled={!newProfileName.trim() || createProfileMut.isPending}
                          onClick={async () => { await createProfileMut.mutateAsync({ name: newProfileName.trim() }); setNewProfileName(""); }}>
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                <div><Label>Tipo de Vínculo</Label>
                  <Select value={form.employment_type} onValueChange={v => setField("employment_type", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(EMPLOYMENT_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <Label>Departamento</Label>
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs gap-1" onClick={() => setShowDeptManager(!showDeptManager)}>
                      <Building2 className="h-3 w-3" /> Gerenciar
                    </Button>
                  </div>
                  <Select value={form.department_id || ""} onValueChange={v => setField("department_id", v)}>
                    <SelectTrigger><SelectValue placeholder="Selecionar" /></SelectTrigger>
                    <SelectContent>
                      {departments.map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                      {departments.length === 0 && <p className="text-xs text-muted-foreground text-center py-2">Nenhum departamento cadastrado</p>}
                    </SelectContent>
                  </Select>
                  {showDeptManager && (
                    <div className="mt-2 p-3 border rounded-lg bg-muted/30 space-y-2">
                      <p className="text-xs font-medium">Departamentos cadastrados:</p>
                      <div className="flex flex-wrap gap-1">
                        {departments.map((d: any) => (
                          <Badge key={d.id} variant="secondary" className="gap-1 pr-1">
                            {d.name}
                            <button onClick={() => deleteDeptMut.mutate(d.id)} className="ml-1 hover:text-destructive"><X className="h-3 w-3" /></button>
                          </Badge>
                        ))}
                      </div>
                      <div className="flex gap-1">
                        <Input value={newDeptName} onChange={e => setNewDeptName(e.target.value)} placeholder="Novo departamento..." className="h-8 text-sm" />
                        <Button size="sm" className="h-8 shrink-0" disabled={!newDeptName.trim() || createDeptMut.isPending}
                          onClick={async () => { await createDeptMut.mutateAsync({ name: newDeptName.trim() }); setNewDeptName(""); }}>
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <Label>Filial / Sede</Label>
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs gap-1" onClick={() => navigate("/rh/pdvs")}>
                      <MapPin className="h-3 w-3" /> Configurar Sedes
                    </Button>
                  </div>
                  <Select value={form.branch_id || ""} onValueChange={v => setField("branch_id", v)}>
                    <SelectTrigger><SelectValue placeholder="Selecionar filial ou sede" /></SelectTrigger>
                    <SelectContent>
                      {branches.map((b: any) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                      {branches.length === 0 && <p className="text-xs text-muted-foreground text-center py-2">Nenhuma filial cadastrada</p>}
                    </SelectContent>
                  </Select>
                </div>
                <div><Label>Salário Mensal (R$)</Label><Input type="number" value={form.salary} onChange={e => setField("salary", e.target.value)} /></div>

                {(editId || showAdvancedTabs) && (
                  <>
                    <div className="col-span-2 space-y-2 p-4 rounded-lg border bg-primary/5">
                      <Label className="text-sm font-semibold flex items-center gap-2"><Calendar className="h-4 w-4" /> Escala Vinculada (Ponto)</Label>
                      <p className="text-xs text-muted-foreground">Define os horários usados pelo sistema de ponto. A jornada abaixo é apenas um demonstrativo/salarial.</p>
                      <div className="flex gap-2 items-end">
                        <div className="flex-1">
                          <Select value={scheduleId || "__none__"} onValueChange={setScheduleId}>
                            <SelectTrigger><SelectValue placeholder="Sem escala vinculada" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Sem escala vinculada</SelectItem>
                              {schedules.filter((s: any) => s.active).map((s: any) => (
                                <SelectItem key={s.id} value={s.id}>
                                  {s.name} — {s.schedule_type} ({(s.entry_time || '').slice(0,5)}-{(s.exit_time || '').slice(0,5)})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          disabled={!editId || !scheduleId || scheduleId === "__none__" || scheduleId === currentSchedule?.schedule_id || assignScheduleMut.isPending}
                          onClick={async () => {
                            if (!editId) return;
                            try {
                              await assignScheduleMut.mutateAsync({ employee_id: editId, schedule_id: scheduleId });
                              const updatedEmployee = await syncScheduleMut.mutateAsync({ id: editId, schedule_id: scheduleId });

                              if (updatedEmployee && updatedEmployee.work_schedule) {
                                setForm((p: any) => ({
                                  ...p,
                                  work_schedule: parseSchedule(updatedEmployee.work_schedule)
                                }));
                              }

                              toast({ title: "Escala vinculada e jornada sincronizada!" });
                            } catch (err) {
                              toast({ title: "Erro ao vincular e sincronizar", variant: "destructive" });
                            }
                          }}
                        >
                          Vincular e Sincronizar
                        </Button>
                      </div>
                      {currentSchedule && (
                        <p className="text-xs text-muted-foreground">
                          Atual: <b>{currentSchedule.schedule_name}</b> — desde {String(currentSchedule.start_date || '').slice(0,10)}
                        </p>
                      )}
                      {!editId && <p className="text-xs text-amber-600">Salve o colaborador antes de vincular uma escala.</p>}
                    </div>

                    <div className="col-span-2 space-y-3 p-4 rounded-lg border bg-muted/30">
                      <Label className="text-sm font-semibold flex items-center gap-2"><Calendar className="h-4 w-4" /> Jornada de Trabalho</Label>
                      {(() => {
                        const sched = form.work_schedule && typeof form.work_schedule === "object" ? form.work_schedule : parseSchedule(form.work_schedule);
                        const updateSched = (patch: any) => setField("work_schedule", { ...sched, ...patch });
                        const toggleDay = (day: string) => updateSched({ days: { ...sched.days, [day]: !sched.days[day] } });

                        const stats = calcScheduleHours(sched);
                        const hourlyRate = stats.monthlyHours > 0 && form.salary ? parseFloat(form.salary) / stats.monthlyHours : 0;

                        return (
                          <>
                            <div className="flex items-center gap-2 mb-4">
                              <Switch
                                checked={sched.useIndividualDays || false}
                                onCheckedChange={v => updateSched({ useIndividualDays: v })}
                              />
                              <Label className="text-xs cursor-pointer" onClick={() => updateSched({ useIndividualDays: !sched.useIndividualDays })}>
                                Personalizar horários por dia da semana
                              </Label>
                            </div>

                        {/* Days of week toggles */}
                        <div className="flex flex-wrap gap-2">
                          {WEEKDAYS.map(wd => (
                            <button key={wd.key} type="button" onClick={() => toggleDay(wd.key)}
                              className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                                sched.days[wd.key]
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : "bg-muted text-muted-foreground border-border hover:bg-accent"
                              }`}>
                              {wd.label}
                            </button>
                          ))}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Dias trabalhados: {Object.entries(sched.days).filter(([,v]) => v).map(([k]) => WEEKDAYS.find(w => w.key === k)?.label).join(", ") || "Nenhum"}
                          {" · "}Folga: {Object.entries(sched.days).filter(([,v]) => !v).map(([k]) => WEEKDAYS.find(w => w.key === k)?.label).join(", ") || "Nenhuma"}
                        </p>

                        {/* Time inputs */}
                        {!sched.useIndividualDays ? (
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div><Label className="text-xs">Entrada</Label><Input type="time" value={sched.entry} onChange={e => updateSched({ entry: e.target.value })} /></div>
                            <div><Label className="text-xs">Saída</Label><Input type="time" value={sched.exit} onChange={e => updateSched({ exit: e.target.value })} /></div>
                            <div><Label className="text-xs">Início Almoço</Label><Input type="time" value={sched.lunch_start} onChange={e => updateSched({ lunch_start: e.target.value })} /></div>
                            <div><Label className="text-xs">Fim Almoço</Label><Input type="time" value={sched.lunch_end} onChange={e => updateSched({ lunch_end: e.target.value })} /></div>
                          </div>
                        ) : (
                          <div className="space-y-3 border rounded-lg p-3 bg-background/50">
                            {WEEKDAYS.map(wd => {
                              const isActive = sched.days[wd.key];
                              if (!isActive) return null;
                              
                              const config = (sched.dayConfig || {})[wd.key] || { entry: "08:00", exit: "17:00", lunch_start: "12:00", lunch_end: "13:00" };
                              const setDayField = (field: string, val: string) => {
                                updateSched({
                                  dayConfig: {
                                    ...(sched.dayConfig || {}),
                                    [wd.key]: { ...config, [field]: val }
                                  }
                                });
                              };

                              return (
                                <div key={wd.key} className="grid grid-cols-1 sm:grid-cols-[80px_1fr_1fr_1fr_1fr] gap-3 items-center border-b last:border-0 pb-2 mb-2 last:pb-0 last:mb-0">
                                  <span className="font-bold text-sm">{wd.label}</span>
                                  <div><Label className="text-[10px] uppercase text-muted-foreground">Entrada</Label><Input className="h-8 text-xs" type="time" value={config.entry} onChange={e => setDayField("entry", e.target.value)} /></div>
                                  <div><Label className="text-[10px] uppercase text-muted-foreground">Saída</Label><Input className="h-8 text-xs" type="time" value={config.exit} onChange={e => setDayField("exit", e.target.value)} /></div>
                                  <div><Label className="text-[10px] uppercase text-muted-foreground">Início Almoço</Label><Input className="h-8 text-xs" type="time" value={config.lunch_start} onChange={e => setDayField("lunch_start", e.target.value)} /></div>
                                  <div><Label className="text-[10px] uppercase text-muted-foreground">Fim Almoço</Label><Input className="h-8 text-xs" type="time" value={config.lunch_end} onChange={e => setDayField("lunch_end", e.target.value)} /></div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Calculated stats */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 rounded-lg bg-background border">
                          <div className="text-center">
                            <p className="text-xs text-muted-foreground">Horas/Dia</p>
                            <p className="text-sm font-semibold">{stats.dailyHours.toFixed(1)}h</p>
                          </div>
                          <div className="text-center">
                            <p className="text-xs text-muted-foreground">Dias/Semana</p>
                            <p className="text-sm font-semibold">{stats.workDays}</p>
                          </div>
                          <div className="text-center">
                            <p className="text-xs text-muted-foreground">Horas/Mês ({stats.monthlyWorkDays}d)</p>
                            <p className="text-sm font-semibold">{stats.monthlyHours.toFixed(0)}h</p>
                          </div>
                          <div className="text-center">
                            <p className="text-xs text-muted-foreground">Valor/Hora</p>
                            <p className="text-sm font-semibold text-primary">R$ {hourlyRate.toFixed(2)}</p>
                          </div>
                        </div>
                          </>
                        );
                      })()}
                    </div>
                  </>
                )}

                <div><Label>Data de Admissão</Label><Input type="date" value={form.admission_date} onChange={e => setField("admission_date", e.target.value)} /></div>
                <div><Label>Supervisor / Responsável</Label>
                  <Select value={form.direct_manager_id || "__none__"} onValueChange={v => setField("direct_manager_id", v === "__none__" ? "" : v)}>
                    <SelectTrigger><SelectValue placeholder="Selecionar supervisor" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Nenhum</SelectItem>
                      {allEmployeesForSupervisor.filter((e: any) => e.id !== editId && (e.worker_profile === 'supervisor' || e.worker_profile === 'administrativo' || e.profile === 'supervisor' || e.profile === 'administrativo')).map((e: any) => (
                        <SelectItem key={e.id} value={e.id}>{e.full_name} ({e.position || e.worker_profile})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div><Label>Status</Label>
                  <Select value={form.status} onValueChange={v => setField("status", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ativo">Ativo</SelectItem>
                      <SelectItem value="afastado">Afastado</SelectItem>
                      <SelectItem value="ferias">Férias</SelectItem>
                      <SelectItem value="suspenso">Suspenso</SelectItem>
                      <SelectItem value="desligado">Desligado</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="md:col-span-2">
                  <Label>Validação Facial (este colaborador)</Label>
                  <Select
                    value={form.facial_required === true ? "always" : form.facial_required === false ? "never" : "default"}
                    onValueChange={v => setField("facial_required", v === "always" ? true : v === "never" ? false : null)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Seguir configuração da organização (padrão)</SelectItem>
                      <SelectItem value="always">Sempre exigir biometria facial</SelectItem>
                      <SelectItem value="never">Dispensar — não exigir facial</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Substitui a configuração global de RH → Biometria Facial apenas para este colaborador.
                  </p>
                </div>

                {/* Seção Ações */}
                <div className="md:col-span-2 space-y-3 mt-2 p-4 rounded-lg border bg-amber-50/50 border-amber-200/60">
                  <Label className="text-sm font-semibold flex items-center gap-2 text-amber-800">
                    <Smartphone className="h-4 w-4" /> Ações — Regras Especiais para este Colaborador
                  </Label>
                  <p className="text-xs text-amber-700/80 mb-3">
                    Configurações que alteram como este colaborador interage com o ponto e as rotas de merchandising.
                  </p>
                  {[
                    {
                      key: "punch_requires_checkin",
                      label: "Requer check-in na loja para bater o ponto",
                      desc: "Se ativado, o ponto só será liberado após o colaborador fazer check-in numa loja/rota ativa.",
                      icon: MapPin,
                      warn: true,
                    },
                    {
                      key: "punch_without_active_route",
                      label: "Permitir bater ponto sem rota ativa",
                      desc: "Se ativado, o colaborador poderá bater ponto mesmo sem rota programada, atribuição diária ou PDV vinculado.",
                      icon: CalendarDays,
                      warn: false,
                    },
                  ].map(r => (
                    <div key={r.key} className="flex items-center justify-between p-3 rounded-lg border bg-background/70">
                      <div className="flex items-start gap-3 max-w-[80%]">
                        <r.icon className={`h-4 w-4 mt-0.5 ${r.warn ? "text-amber-600" : "text-muted-foreground"}`} />
                        <div>
                          <span className="text-sm font-medium leading-tight block">{r.label}</span>
                          <span className="text-xs text-muted-foreground block mt-1">{r.desc}</span>
                        </div>
                      </div>
                      <Switch
                        checked={!!form[r.key]}
                        onCheckedChange={v => setField(r.key, v)}
                      />
                    </div>
                  ))}
                </div>

                {/* Acesso App Promotor */}
                {editId && <PromotorAccessToggle employeeId={editId} />}
              </div>
            </TabsContent>

            {(editId || showAdvancedTabs) && (
              <TabsContent value="remuneracao" className="space-y-4 mt-4">
              {/* Composição Salarial */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold flex items-center gap-2"><DollarSign className="h-4 w-4 text-primary" /> Composição Salarial</h3>
                  <Button type="button" variant="outline" size="sm" className="h-7 text-xs gap-1"
                    onClick={() => setForm((p: any) => ({
                      ...p,
                      salary_items: [...(p.salary_items || []), { type: "Salário Base", description: "", value: "" }]
                    }))}>
                    <Plus className="h-3 w-3" /> Adicionar Item
                  </Button>
                </div>
                {(form.salary_items || []).length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4 border rounded-lg border-dashed">Nenhum item de composição salarial adicionado</p>
                )}
                {(form.salary_items || []).map((item: any, idx: number) => (
                  <div key={idx} className="grid grid-cols-[1fr_1.5fr_auto_auto] gap-2 items-end p-3 rounded-lg bg-muted/30 border">
                    <div>
                      <Label className="text-xs">Tipo</Label>
                      <Select value={item.type} onValueChange={v => {
                        const items = [...form.salary_items];
                        items[idx] = { ...items[idx], type: v };
                        setField("salary_items", items);
                      }}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {SALARY_ITEM_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Descrição</Label>
                      <Input className="h-8 text-xs" placeholder="Detalhes..." value={item.description}
                        onChange={e => {
                          const items = [...form.salary_items];
                          items[idx] = { ...items[idx], description: e.target.value };
                          setField("salary_items", items);
                        }} />
                    </div>
                    <div>
                      <Label className="text-xs">Valor (R$)</Label>
                      <Input className="h-8 text-xs w-28" type="number" placeholder="0,00" value={item.value}
                        onChange={e => {
                          const items = [...form.salary_items];
                          items[idx] = { ...items[idx], value: e.target.value };
                          setField("salary_items", items);
                        }} />
                    </div>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                      onClick={() => {
                        const items = form.salary_items.filter((_: any, i: number) => i !== idx);
                        setField("salary_items", items);
                      }}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                {(form.salary_items || []).length > 0 && (
                  <div className="flex justify-end p-2 rounded-lg bg-primary/5 border border-primary/20">
                    <p className="text-sm font-semibold">Total Composição: <span className="text-primary">
                      R$ {(form.salary_items || []).reduce((s: number, i: any) => s + (parseFloat(i.value) || 0), 0).toFixed(2)}
                    </span></p>
                  </div>
                )}
              </div>

              {/* Benefícios */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold flex items-center gap-2"><Gift className="h-4 w-4 text-primary" /> Benefícios</h3>
                  <Button type="button" variant="outline" size="sm" className="h-7 text-xs gap-1"
                    onClick={() => setForm((p: any) => ({
                      ...p,
                      benefits: [...(p.benefits || []), { type: "Vale Refeição", description: "", value: "", employer_cost: "" }]
                    }))}>
                    <Plus className="h-3 w-3" /> Adicionar Benefício
                  </Button>
                </div>
                {(form.benefits || []).length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4 border rounded-lg border-dashed">Nenhum benefício adicionado</p>
                )}
                {(form.benefits || []).map((ben: any, idx: number) => (
                  <div key={idx} className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-2 items-end p-3 rounded-lg bg-muted/30 border">
                    <div>
                      <Label className="text-xs">Benefício</Label>
                      <Select value={ben.type} onValueChange={v => {
                        const items = [...form.benefits];
                        items[idx] = { ...items[idx], type: v };
                        setField("benefits", items);
                      }}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {BENEFIT_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Descrição</Label>
                      <Input className="h-8 text-xs" placeholder="Detalhes..." value={ben.description}
                        onChange={e => {
                          const items = [...form.benefits];
                          items[idx] = { ...items[idx], description: e.target.value };
                          setField("benefits", items);
                        }} />
                    </div>
                    <div>
                      <Label className="text-xs">Valor (R$)</Label>
                      <Input className="h-8 text-xs w-24" type="number" placeholder="0,00" value={ben.value}
                        onChange={e => {
                          const items = [...form.benefits];
                          items[idx] = { ...items[idx], value: e.target.value };
                          setField("benefits", items);
                        }} />
                    </div>
                    <div>
                      <Label className="text-xs">Custo Empresa</Label>
                      <Input className="h-8 text-xs w-24" type="number" placeholder="0,00" value={ben.employer_cost}
                        onChange={e => {
                          const items = [...form.benefits];
                          items[idx] = { ...items[idx], employer_cost: e.target.value };
                          setField("benefits", items);
                        }} />
                    </div>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive"
                      onClick={() => {
                        const items = form.benefits.filter((_: any, i: number) => i !== idx);
                        setField("benefits", items);
                      }}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                {(form.benefits || []).length > 0 && (
                  <div className="flex justify-between p-2 rounded-lg bg-primary/5 border border-primary/20 text-sm">
                    <p className="font-semibold">Total Benefícios: <span className="text-primary">
                      R$ {(form.benefits || []).reduce((s: number, i: any) => s + (parseFloat(i.value) || 0), 0).toFixed(2)}
                    </span></p>
                    <p className="font-semibold">Custo Empresa: <span className="text-destructive">
                      R$ {(form.benefits || []).reduce((s: number, i: any) => s + (parseFloat(i.employer_cost) || 0), 0).toFixed(2)}
                    </span></p>
                  </div>
                )}
              </div>

              {/* Resumo Geral */}
              {((form.salary_items || []).length > 0 || (form.benefits || []).length > 0) && (
                <div className="p-3 rounded-lg bg-primary/10 border border-primary/30 space-y-1">
                  <h4 className="text-sm font-bold text-primary">Resumo da Remuneração</h4>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-xs text-muted-foreground">Composição Salarial</p>
                      <p className="font-semibold text-sm">R$ {(form.salary_items || []).reduce((s: number, i: any) => s + (parseFloat(i.value) || 0), 0).toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Benefícios</p>
                      <p className="font-semibold text-sm">R$ {(form.benefits || []).reduce((s: number, i: any) => s + (parseFloat(i.value) || 0), 0).toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Total Geral</p>
                      <p className="font-bold text-sm text-primary">R$ {(
                        (form.salary_items || []).reduce((s: number, i: any) => s + (parseFloat(i.value) || 0), 0) +
                        (form.benefits || []).reduce((s: number, i: any) => s + (parseFloat(i.value) || 0), 0)
                      ).toFixed(2)}</p>
                    </div>
                  </div>
                </div>
              )}
              </TabsContent>
            )}

            {(editId || showAdvancedTabs) && (
              <TabsContent value="documentos" className="space-y-4 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div><Label>CTPS Número</Label><Input value={form.ctps_number} onChange={e => setField("ctps_number", e.target.value)} /></div>
                <div><Label>PIS/PASEP</Label><Input value={form.pis_pasep} onChange={e => setField("pis_pasep", e.target.value)} /></div>
                {form.employment_type === "pj" && (
                  <>
                    <div><Label>CNPJ</Label><Input value={form.cnpj} onChange={e => setField("cnpj", e.target.value)} /></div>
                    <div><Label>Razão Social</Label><Input value={form.company_name} onChange={e => setField("company_name", e.target.value)} /></div>
                  </>
                )}
              </div>

              <div className="border-t pt-4">
                <Label className="text-sm font-semibold flex items-center gap-2 mb-2">
                  <FileText className="h-4 w-4" /> Arquivos do Colaborador
                </Label>
                {editId ? (
                  <EmployeeDocumentsManager employeeId={editId} />
                ) : (
                  <p className="text-sm text-muted-foreground p-4 border border-dashed rounded-lg text-center">
                    Salve o colaborador primeiro para anexar documentos.
                  </p>
                )}
              </div>
              </TabsContent>
            )}

            {(editId || showAdvancedTabs) && (
              <TabsContent value="bancario" className="space-y-3 mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div><Label>Banco</Label><Input value={form.bank_name} onChange={e => setField("bank_name", e.target.value)} /></div>
                <div><Label>Agência</Label><Input value={form.bank_agency} onChange={e => setField("bank_agency", e.target.value)} /></div>
                <div><Label>Conta</Label><Input value={form.bank_account} onChange={e => setField("bank_account", e.target.value)} /></div>
                <div><Label>Tipo de Conta</Label>
                  <Select value={form.bank_account_type || ""} onValueChange={v => setField("bank_account_type", v)}>
                    <SelectTrigger><SelectValue placeholder="Selecionar" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="corrente">Corrente</SelectItem>
                      <SelectItem value="poupanca">Poupança</SelectItem>
                      <SelectItem value="salario">Conta Salário</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="border-t pt-3 space-y-3">
                <Label className="text-sm font-semibold flex items-center gap-2">
                  <KeyRound className="h-4 w-4" /> Chave PIX
                </Label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <Label>Tipo da Chave</Label>
                    <Select value={form.pix_key_type || ""} onValueChange={v => setField("pix_key_type", v)}>
                      <SelectTrigger><SelectValue placeholder="Selecionar" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cpf">CPF</SelectItem>
                        <SelectItem value="cnpj">CNPJ</SelectItem>
                        <SelectItem value="email">E-mail</SelectItem>
                        <SelectItem value="telefone">Telefone</SelectItem>
                        <SelectItem value="aleatoria">Chave Aleatória</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="md:col-span-2">
                    <Label>Chave PIX</Label>
                    <Input value={form.pix_key} onChange={e => setField("pix_key", e.target.value)} placeholder="Digite a chave PIX" />
                  </div>
                </div>
              </div>
              </TabsContent>
            )}
          </Tabs>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={createMut.isPending || updateMut.isPending}>
              {createMut.isPending || updateMut.isPending ? "Salvando..." : "Salvar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <EmployeeOnboardingLinkDialog
        open={!!onboardingTarget}
        onOpenChange={(o) => !o && setOnboardingTarget(null)}
        employeeId={onboardingTarget?.id || null}
        employeeName={onboardingTarget?.name || null}
      />
      <EmployeeImportExportDialog
        open={importExportOpen}
        onOpenChange={setImportExportOpen}
        employees={rawEmployees}
        departments={departments}
        branches={branches}
        onImport={async (rows) => {
          for (const row of rows) {
            await createMut.mutateAsync(row);
          }
        }}
      />
    </MainLayout>
  );
}

function generateTempPassword() {
  const nums = String(Math.floor(Math.random() * 900 + 100));
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const letters = chars[Math.floor(Math.random() * 26)] + chars[Math.floor(Math.random() * 26)];
  return `ayra${nums}${letters}`;
}

function PromotorAccessToggle({ employeeId }: { employeeId: string }) {
  const { data: access, isLoading } = useAppAccess(employeeId);
  const grantAccess = useGrantAppAccess();
  const blockAccess = useBlockAppAccess();
  const resetPassword = useResetAppPassword();
  const { toast } = useToast();
  const [generatedPass, setGeneratedPass] = React.useState<string | null>(null);

  const isEnabled = access && ['liberado', 'aguardando_login', 'ativo'].includes(access.access_status);

  const handleToggle = async (enabled: boolean) => {
    try {
      if (enabled) {
        const tempPass = generateTempPassword();
        await grantAccess.mutateAsync({ employee_id: employeeId, password: tempPass });
        setGeneratedPass(tempPass);
        toast({ title: "Acesso liberado!" });
      } else {
        await blockAccess.mutateAsync(employeeId);
        setGeneratedPass(null);
        toast({ title: "Acesso bloqueado" });
      }
    } catch {
      toast({ title: "Erro ao alterar acesso", variant: "destructive" });
    }
  };

  const handleResetPassword = async () => {
    try {
      const newPass = generateTempPassword();
      await resetPassword.mutateAsync({ employee_id: employeeId, new_password: newPass });
      setGeneratedPass(newPass);
      toast({ title: "Nova senha gerada!" });
    } catch {
      toast({ title: "Erro ao gerar nova senha", variant: "destructive" });
    }
  };

  const copyPassword = () => {
    if (generatedPass) {
      navigator.clipboard.writeText(generatedPass);
      toast({ title: "Senha copiada!" });
    }
  };

  return (
    <div className="col-span-2 space-y-2">
      <div className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
        <Smartphone className="h-5 w-5 text-primary" />
        <div className="flex-1">
          <Label className="text-sm font-medium">Acesso ao App do Promotor</Label>
          <p className="text-xs text-muted-foreground">
            {isLoading ? "Carregando..." : isEnabled ? `Status: ${access.access_status} • Último login: ${access.last_login ? new Date(access.last_login).toLocaleDateString('pt-BR') : 'Nunca'}` : "Sem acesso ao aplicativo"}
          </p>
        </div>
        <Switch
          checked={!!isEnabled}
          onCheckedChange={handleToggle}
          disabled={isLoading || grantAccess.isPending || blockAccess.isPending}
        />
      </div>
      {isEnabled && (
        <Button type="button" variant="outline" size="sm" onClick={handleResetPassword} disabled={resetPassword.isPending}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${resetPassword.isPending ? 'animate-spin' : ''}`} /> Gerar nova senha
        </Button>
      )}
      {generatedPass && (
        <div className="flex items-center gap-2 p-2 rounded-md border border-primary/30 bg-primary/5">
          <KeyRound className="h-4 w-4 text-primary" />
          <span className="text-sm font-mono font-medium flex-1">{generatedPass}</span>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={copyPassword}>
            <Copy className="h-3.5 w-3.5 mr-1" /> Copiar
          </Button>
        </div>
      )}
    </div>
  );
}

// ============ Employee Documents Manager (drag & drop + naming) ============
function EmployeeDocumentsManager({ employeeId }: { employeeId: string }) {
  const { data: docs = [], isLoading } = useRhDocuments({ employee_id: employeeId });
  const createDoc = useCreateRhDocument();
  const deleteDoc = useDeleteRhDocument();
  const { toast } = useToast();
  const [isDragging, setIsDragging] = React.useState(false);
  const [pending, setPending] = React.useState<{ file: File; title: string; doc_type: string }[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const DOC_TYPES = ["RG", "CPF", "CNH", "Comprovante de Residência", "CTPS", "PIS", "Título de Eleitor", "Certificado de Reservista", "Contrato", "Atestado", "Certificado", "Exame Admissional", "Outro"];

  const addFiles = (files: FileList | File[]) => {
    const arr = Array.from(files).map(f => ({
      file: f,
      title: f.name.replace(/\.[^.]+$/, ""),
      doc_type: "Outro",
    }));
    setPending(prev => [...prev, ...arr]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  const { uploadFile } = useUpload();

  const handleUploadAll = async () => {
    if (!pending.length) return;
    setUploading(true);
    try {
      for (const item of pending) {
        const url = await uploadFile(item.file);
        if (!url) throw new Error("Falha no upload");
        await createDoc.mutateAsync({
          employee_id: employeeId,
          doc_type: item.doc_type,
          title: item.title || item.file.name,
          file_url: url,
          status: "aprovado",
        });
      }
      setPending([]);
      toast({ title: "Documentos enviados!" });
    } catch (err: any) {
      toast({ title: "Erro ao enviar documentos", description: err?.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
          isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 bg-muted/30"
        }`}
      >
        <FileText className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm font-medium">Arraste arquivos aqui ou clique para selecionar</p>
        <p className="text-xs text-muted-foreground mt-1">PDF, imagens, DOC, XLS (até 100MB)</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
        />
      </div>

      {pending.length > 0 && (
        <div className="space-y-2 p-3 rounded-lg border bg-card">
          <p className="text-xs font-semibold text-muted-foreground uppercase">Pendentes de envio</p>
          {pending.map((item, idx) => (
            <div key={idx} className="grid grid-cols-1 md:grid-cols-[1fr_180px_auto] gap-2 items-center p-2 border rounded-md">
              <Input
                value={item.title}
                onChange={e => setPending(prev => prev.map((p, i) => i === idx ? { ...p, title: e.target.value } : p))}
                placeholder="Nome do documento"
              />
              <Select value={item.doc_type} onValueChange={v => setPending(prev => prev.map((p, i) => i === idx ? { ...p, doc_type: v } : p))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground truncate max-w-[100px]">{item.file.name}</span>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7"
                  onClick={() => setPending(prev => prev.filter((_, i) => i !== idx))}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" size="sm" onClick={handleUploadAll} disabled={uploading} className="w-full">
            {uploading ? <><Loader2 className="h-3 w-3 mr-2 animate-spin" /> Enviando...</> : <>Enviar {pending.length} arquivo(s)</>}
          </Button>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase">Documentos salvos ({docs.length})</p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground text-center py-3">Carregando...</p>
        ) : docs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-3">Nenhum documento anexado.</p>
        ) : (
          docs.map((doc: any) => (
            <div key={doc.id} className="flex items-center gap-2 p-2 border rounded-md bg-card">
              <FileText className="h-4 w-4 text-primary flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{doc.title}</p>
                <p className="text-xs text-muted-foreground">{doc.doc_type} • {new Date(doc.created_at).toLocaleDateString('pt-BR')}</p>
              </div>
              {doc.file_url && (
                <Button type="button" variant="ghost" size="sm" asChild>
                  <a href={doc.file_url} target="_blank" rel="noreferrer">Abrir</a>
                </Button>
              )}
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                onClick={() => { if (confirm("Excluir este documento?")) deleteDoc.mutate(doc.id); }}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
