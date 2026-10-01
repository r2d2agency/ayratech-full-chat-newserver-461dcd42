import { useState, useMemo, useCallback } from "react";
import { MainLayout } from "@/components/layout/MainLayout";
import { useTimeRecords, useSaveTimeRecord, useEmployees, useAppPunches, useConsolidatedTimesheet, usePunchDivergences, useCreatePunch, useUpdatePunch, useDeletePunch, useCartaoPonto, useCartaoPontoUpdate, useCartaoPontoAudit, usePeriodClose } from "@/hooks/use-rh";
import type { CartaoDay } from "@/hooks/use-rh";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Clock, Smartphone, MapPin, CheckCircle2, AlertTriangle, Wifi, WifiOff,
  Download, FileSpreadsheet, CalendarDays, CalendarRange, Calendar, Filter,
  TrendingUp, UserX, ShieldAlert, Pencil, Trash2, Wrench
} from "lucide-react";
import { OvertimeRequestsPanel, useOvertimePendingCount } from "@/components/rh/OvertimeRequestsPanel";
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, subDays, subMonths } from "date-fns";
import { exportCartaoPontoPdf } from "@/lib/cartao-ponto-pdf";
import * as XLSX from "xlsx";

const STATUS_LABELS: Record<string, string> = {
  normal: "Normal", falta: "Falta", atestado: "Atestado", feriado: "Feriado", compensado: "Compensado",
};

const GEO_LABELS: Record<string, { label: string; variant: "default" | "destructive" | "outline" | "secondary" }> = {
  dentro_area: { label: "Dentro PDV", variant: "default" },
  fora_area: { label: "Fora PDV", variant: "destructive" },
  excecao: { label: "Exceção", variant: "secondary" },
  sem_gps: { label: "Sem GPS", variant: "outline" },
  sem_pdv: { label: "Sem PDV", variant: "outline" },
};

const PUNCH_LABELS: Record<string, string> = {
  entrada: '🟢 Entrada', saida_intervalo: '🟡 Saída Intervalo', retorno_intervalo: '🔵 Retorno', saida: '🔴 Saída', extraordinaria: '⚪ Extra', ajuste: '🔧 Ajuste'
};

const DIVERGENCE_ICONS: Record<string, { icon: typeof AlertTriangle; color: string }> = {
  sem_registro: { icon: AlertTriangle, color: 'text-destructive' },
  incompleto: { icon: Clock, color: 'text-primary' },
  fora_pdv: { icon: MapPin, color: 'text-accent-foreground' },
};

type PeriodPreset = 'hoje' | 'semana' | 'mes' | 'mes_anterior' | 'personalizado';

const CARTAO_DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// O backend manda date como 'YYYY-MM-DD' e nunca como Date: formatar direto,
// sem passar por date-fns, evita que o fuso do navegador empurre a linha um dia.
function dayLabel(day: CartaoDay): string {
  const [, m, d] = day.date.split('-');
  const dow = day.isoDow ? CARTAO_DOW[day.isoDow - 1] : '';
  return `${dow} ${d}/${m}`;
}

function statusLabel(day: CartaoDay): string {
  if (day.dayType === 'feriado') return day.holidayName || 'Feriado';
  if (day.dayType === 'ausencia') return day.absenceType || 'Afastado';
  if (day.dayType === 'folga') return 'Folga';
  return '';
}

// new Date()/date-fns usam o fuso horário do navegador de quem está vendo a
// tela — um admin acessando fora do fuso de Brasília (ou com o relógio do
// aparelho mal configurado) via "Hoje"/formatação de data via um dia
// diferente do real, fazendo batidas somem/apareçam no dia errado. Essas
// duas funções forçam América/São Paulo independente do fuso do navegador.
function nowSaoPaulo(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function toSaoPauloDate(d: Date): Date | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const converted = new Date(d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  return Number.isNaN(converted.getTime()) ? null : converted;
}

function getPeriodDates(preset: PeriodPreset): { start: string; end: string } {
  const now = nowSaoPaulo();
  switch (preset) {
    case 'hoje':
      return { start: format(now, 'yyyy-MM-dd'), end: format(now, 'yyyy-MM-dd') };
    case 'semana':
      return { start: format(startOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd'), end: format(endOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd') };
    case 'mes':
      return { start: format(startOfMonth(now), 'yyyy-MM-dd'), end: format(endOfMonth(now), 'yyyy-MM-dd') };
    case 'mes_anterior': {
      const prev = subMonths(now, 1);
      return { start: format(startOfMonth(prev), 'yyyy-MM-dd'), end: format(endOfMonth(prev), 'yyyy-MM-dd') };
    }
    default:
      return { start: format(subDays(now, 30), 'yyyy-MM-dd'), end: format(now, 'yyyy-MM-dd') };
  }
}

function parseDateValue(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // Coluna DATE do Postgres chega como "2026-09-30" ou "2026-09-30T00:00:00.000Z".
  // Tratar esse sufixo como instante UTC converte para o dia ANTERIOR em São
  // Paulo (00:00Z = 21:00 do dia prévio), fazendo a batida de hoje aparecer
  // como ontem — o mesmo deslocamento que afetava os feriados.
  const calendarDate = raw.match(/^(\d{4}-\d{2}-\d{2})(?:$|T00:00)/)?.[1];
  if (calendarDate) return new Date(`${calendarDate}T12:00:00`);

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T12:00:00`
    : raw.includes(' ') && !raw.includes('T')
      ? raw.replace(' ', 'T')
      : raw;

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateValue(value: unknown, mask: string, fallback = '—') {
  // Datas de calendário (coluna DATE) já vêm ancoradas ao meio-dia local em
  // parseDateValue; reconvertê-las para São Paulo as deslocaria para o dia
  // anterior em fusos à frente. Só instantes reais (punched_at) são convertidos.
  const parsed = parseDateValue(value);
  if (!parsed) return fallback;
  if (isCalendarDateValue(value)) return format(parsed, mask);
  const saoPauloDate = toSaoPauloDate(parsed);
  return saoPauloDate ? format(saoPauloDate, mask) : fallback;
}

function isCalendarDateValue(value: unknown): boolean {
  if (value instanceof Date) return false;
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) || /^(\d{4}-\d{2}-\d{2})(?:$|T00:00)/.test(raw);
}

function getPunchTimestamp(punch: any) {
  return punch?.punched_at || punch?.offline_local_time || punch?.created_at || null;
}

export default function RHPonto() {
  const overtimePendingCount = useOvertimePendingCount();
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>('mes');
  const [customStart, setCustomStart] = useState(format(startOfMonth(nowSaoPaulo()), 'yyyy-MM-dd'));
  const [customEnd, setCustomEnd] = useState(format(nowSaoPaulo(), 'yyyy-MM-dd'));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("validation");
  const [reportType, setReportType] = useState<'todos' | 'horas_extras' | 'faltas'>('todos');
  const [form, setForm] = useState<any>({ employee_id: "", record_date: format(nowSaoPaulo(), "yyyy-MM-dd"), entry1: "08:00", exit1: "12:00", entry2: "13:00", exit2: "17:00", entry3: "", exit3: "", status: "normal", justification: "" });
  const { toast } = useToast();

  const { start: startDate, end: endDate } = useMemo(() => {
    if (periodPreset === 'personalizado') return { start: customStart, end: customEnd };
    return getPeriodDates(periodPreset);
  }, [periodPreset, customStart, customEnd]);

  const { data: records = [], isLoading } = useTimeRecords({ employee_id: employeeFilter || undefined, start_date: startDate, end_date: endDate });
  const { data: appPunches = [], isLoading: loadingPunches } = useAppPunches({ employee_id: employeeFilter || undefined, start_date: startDate, end_date: endDate });
  const { data: consolidated = [], isLoading: loadingConsolidated } = useConsolidatedTimesheet({ employee_id: employeeFilter || undefined, start_date: startDate, end_date: endDate });
  const { data: divergences = [] } = usePunchDivergences({ start_date: startDate, end_date: endDate });
  const { data: employees = [] } = useEmployees({ status: "ativo" });
  const saveMut = useSaveTimeRecord();
  const createPunchMut = useCreatePunch();
  const updatePunchMut = useUpdatePunch();
  const deletePunchMut = useDeletePunch();

  // ===== CARTAO DE PONTO =====
  // A ficha e sempre de UM colaborador: sem selecao nao ha tabela para carregar.
  const [cartaoEmployee, setCartaoEmployee] = useState("");
  const [cartaoPreset, setCartaoPreset] = useState<PeriodPreset>('mes');
  const [cartaoStart, setCartaoStart] = useState(format(startOfMonth(nowSaoPaulo()), "yyyy-MM-dd"));
  const [cartaoEnd, setCartaoEnd] = useState(format(nowSaoPaulo(), "yyyy-MM-dd"));
  const [cartaoDialogOpen, setCartaoDialogOpen] = useState(false);
  const [cartaoAuditDate, setCartaoAuditDate] = useState<string | null>(null);
  const [cartaoForm, setCartaoForm] = useState<{ date: string; times: string[]; reason: string; locked: boolean }>(
    { date: "", times: [], reason: "", locked: false },
  );
  // Mesmos presets da barra global. getPeriodDates ancla tudo em nowSaoPaulo(),
  // entao 'Mês Anterior' fecha no ultimo dia do mes anterior de verdade -- foi
  // o erro que o consolidado teve antes (virava dia 29). Precisa ficar acima
  // do useCartaoPonto: usar a variavel antes do useMemo e um TDZ em runtime.
  const { start: cartaoStartDate, end: cartaoEndDate } = useMemo(() => {
    if (cartaoPreset === 'personalizado') return { start: cartaoStart, end: cartaoEnd };
    return getPeriodDates(cartaoPreset);
  }, [cartaoPreset, cartaoStart, cartaoEnd]);

  const { data: cartao, isLoading: loadingCartao } = useCartaoPonto({
    employee_id: cartaoEmployee || undefined,
    start: cartaoStartDate,
    end: cartaoEndDate,
  });
  const { data: cartaoAudit = [] } = useCartaoPontoAudit({
    employee_id: cartaoEmployee || undefined,
    date: cartaoAuditDate || undefined,
  });
  const cartaoUpdateMut = useCartaoPontoUpdate();
  const periodCloseMut = usePeriodClose();

  const openCartaoDay = (day: CartaoDay) => {
    setCartaoForm({
      date: day.date,
      times: day.punches.length
        ? day.punches.map((p) => p.time ?? "00:00")
        : [day.schedule.entry || "08:00"],
      reason: "",
      // Periodo fechado bloqueia a edicao, mas o gestor precisa ainda ler as batidas.
      locked: day.closed,
    });
    setCartaoAuditDate(day.date);
    setCartaoDialogOpen(true);
  };

  const saveCartaoDay = async () => {
    const times = cartaoForm.times.map((t) => String(t).slice(0, 5)).filter(Boolean);
    if (!times.length) {
      toast({ title: "Informe ao menos uma batida", variant: "destructive" });
      return;
    }
    if (!cartaoForm.reason.trim()) {
      toast({ title: "Informe o motivo da correção", variant: "destructive" });
      return;
    }
    try {
      await cartaoUpdateMut.mutateAsync({
        employee_id: cartaoEmployee,
        date: cartaoForm.date,
        times,
        reason: cartaoForm.reason.trim(),
      });
      setCartaoDialogOpen(false);
      toast({ title: `Batidas de ${cartaoForm.date.split("-").reverse().join("/")} corrigidas` });
    } catch (err: any) {
      // 423: o mes foi fechado depois que o dialogo abriu. Nao fechar a janela,
      // mostrar por que ela parou de aceitar edicao.
      const status = err?.status ?? err?.response?.status;
      if (status === 423) {
        setCartaoForm((f) => ({ ...f, locked: true }));
        toast({ title: "Período fechado", description: "Reabra o mês para corrigir este dia.", variant: "destructive" });
        return;
      }
      toast({ title: "Erro ao salvar", description: err?.message, variant: "destructive" });
    }
  };

  const toggleCartaoPeriod = (closed: boolean) => {
    const reference_month = cartaoEndDate.slice(0, 7);
    periodCloseMut.mutate(
      { employee_id: cartaoEmployee, reference_month, closed },
      {
        onSuccess: () => toast({ title: closed ? `Mês ${reference_month} fechado` : `Mês ${reference_month} reaberto` }),
        onError: (e: any) => toast({ title: "Erro", description: e?.message, variant: "destructive" }),
      },
    );
  };

  const [punchDialogOpen, setPunchDialogOpen] = useState(false);
  const [punchForm, setPunchForm] = useState<any>({
    id: null, employee_id: "", punch_type: "entrada",
    date: format(nowSaoPaulo(), "yyyy-MM-dd"), time: "08:00",
    adjustment_reason: "",
  });
  const openNewPunch = () => {
    setPunchForm({ id: null, employee_id: employeeFilter || "", punch_type: "entrada", date: format(nowSaoPaulo(), "yyyy-MM-dd"), time: "08:00", adjustment_reason: "" });
    setPunchDialogOpen(true);
  };
  const openEditPunch = (p: any) => {
    const dt = parseDateValue(getPunchTimestamp(p));
    const dtSp = dt ? toSaoPauloDate(dt) : null;
    setPunchForm({
      id: p.id,
      employee_id: p.employee_id,
      punch_type: p.punch_type,
      date: dtSp ? format(dtSp, "yyyy-MM-dd") : format(nowSaoPaulo(), "yyyy-MM-dd"),
      time: dtSp ? format(dtSp, "HH:mm") : "08:00",
      adjustment_reason: p.adjustment_reason || "",
    });
    setPunchDialogOpen(true);
  };
  const savePunch = async () => {
    if (!punchForm.employee_id || !punchForm.date || !punchForm.time) {
      toast({ title: "Preencha colaborador, data e hora", variant: "destructive" }); return;
    }
    if (!punchForm.adjustment_reason?.trim()) {
      toast({ title: "Informe o motivo do ajuste", variant: "destructive" }); return;
    }
    const hhmm = String(punchForm.time).slice(0, 5);
    const punched_at = `${punchForm.date}T${hhmm}:00`;
    try {
      if (punchForm.id) {
        await updatePunchMut.mutateAsync({ id: punchForm.id, punched_at, punch_type: punchForm.punch_type, adjustment_reason: punchForm.adjustment_reason });
        toast({ title: "Ajuste salvo" });
      } else {
        await createPunchMut.mutateAsync({ employee_id: punchForm.employee_id, punch_type: punchForm.punch_type, punched_at, adjustment_reason: punchForm.adjustment_reason });
        toast({ title: "Ponto manual registrado" });
      }
      setPunchDialogOpen(false);
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    }
  };
  const removePunch = async (p: any) => {
    const reason = window.prompt(`Motivo para remover a marcação (${PUNCH_LABELS[p.punch_type] || p.punch_type} - ${formatDateValue(getPunchTimestamp(p), "dd/MM HH:mm")}):`);
    if (!reason || !reason.trim()) return;
    try {
      await deletePunchMut.mutateAsync({ id: p.id, reason: reason.trim() });
      toast({ title: "Marcação removida" });
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    }
  };

  const filteredDivergences = useMemo(() => {
    if (!employeeFilter) return divergences;
    return divergences.filter((d: any) => d.employee_id === employeeFilter);
  }, [divergences, employeeFilter]);

  const filteredConsolidated = useMemo(() => {
    if (reportType === 'todos') return consolidated;
    if (reportType === 'horas_extras') return consolidated.filter((c: any) => {
      const hours = c.raw_hours ? Number(c.raw_hours) : 0;
      return hours > 8;
    });
    // faltas
    return consolidated.filter((c: any) => {
      const hours = c.raw_hours ? Number(c.raw_hours) : 0;
      return hours < 8;
    });
  }, [consolidated, reportType]);

  const filteredRecords = useMemo(() => {
    if (reportType === 'todos') return records;
    if (reportType === 'horas_extras') return records.filter((r: any) => parseFloat(r.overtime_hours) > 0);
    return records.filter((r: any) => r.status === 'falta' || (r.total_hours && parseFloat(r.total_hours) < 8));
  }, [records, reportType]);

  const calcMinutes = (f: any) => {
    let total = 0;
    const calc = (entry: string, exit: string) => {
      if (!entry || !exit) return 0;
      const [eh, em] = entry.split(":").map(Number);
      const [xh, xm] = exit.split(":").map(Number);
      return (xh * 60 + xm - eh * 60 - em);
    };
    total += calc(f.entry1, f.exit1);
    total += calc(f.entry2, f.exit2);
    total += calc(f.entry3, f.exit3);
    return total;
  };

  const formatMinutesToHHMM = (m: number) => {
    if (!m || m <= 0) return '00:00';
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  const handleSave = async () => {
    if (!form.employee_id || !form.record_date) {
      toast({ title: "Selecione o colaborador e a data", variant: "destructive" });
      return;
    }

    const pairs = [
      ['entry1', 'exit1', '1º período'],
      ['entry2', 'exit2', 'intervalo'],
      ['entry3', 'exit3', '3º período'],
    ] as const;
    const incomplete = pairs.find(([entry, exit]) => Boolean(form[entry]) !== Boolean(form[exit]));
    if (incomplete) {
      toast({
        title: "Horário incompleto",
        description: `Preencha a hora inicial e a hora final do ${incomplete[2]} ou deixe os dois campos vazios.`,
        variant: "destructive",
      });
      return;
    }

    const hasHours = pairs.some(([entry, exit]) => form[entry] && form[exit]);
    if (!hasHours) {
      toast({
        title: "Informe os horários",
        description: "Preencha pelo menos uma hora inicial e uma hora final para lançar o ponto.",
        variant: "destructive",
      });
      return;
    }

    const totalMinutes = calcMinutes(form);
    const totalH = totalMinutes / 60;
    const overtime = Math.max(0, totalH - 8);
    try {
      await saveMut.mutateAsync({ ...form, total_hours: totalH, overtime_hours: overtime });
      toast({ title: "Ponto registrado!" });
      setDialogOpen(false);
    } catch (error: any) {
      toast({
        title: "Não foi possível salvar o ajuste",
        description: error?.message || "Verifique os horários informados e tente novamente.",
        variant: "destructive",
      });
    }
  };

  const setField = (k: string, v: any) => setForm((p: any) => ({ ...p, [k]: v }));

  const exportEmployeeXLS = useCallback((empId?: string) => {
    const empData = empId
      ? consolidated.filter((c: any) => c.employee_id === empId)
      : consolidated;

    if (!empData.length) {
      toast({ title: "Nenhum dado para exportar", variant: "destructive" });
      return;
    }

    const empName = empId ? empData[0]?.employee_name : 'Todos';
    const rows = empData.map((c: any) => {
      const punches = Array.isArray(c.punches) ? c.punches : [];
      const entrada = punches.find((p: any) => p.punch_type === 'entrada');
      const saidaInt = punches.find((p: any) => p.punch_type === 'saida_intervalo');
      const retorno = punches.find((p: any) => p.punch_type === 'retorno_intervalo');
      const saida = punches.find((p: any) => p.punch_type === 'saida');

      return {
        'Data': formatDateValue(c.record_date, 'dd/MM/yyyy', ''),
        'Colaborador': c.employee_name,
        'Matrícula': c.registration_number || '',
        'CPF': c.cpf || '',
        'PIS': c.pis_pasep || '',
        'Cargo': c.position || '',
        'Entrada 1': formatDateValue(getPunchTimestamp(entrada), 'HH:mm', ''),
        'Saída 1': formatDateValue(getPunchTimestamp(saidaInt), 'HH:mm', ''),
        'Entrada 2': formatDateValue(getPunchTimestamp(retorno), 'HH:mm', ''),
        'Saída 2': formatDateValue(getPunchTimestamp(saida), 'HH:mm', ''),
        'Horas Trabalhadas': c.formatted_hours || (c.total_minutes ? formatMinutesToHHMM(c.total_minutes) : ''),
        'Status Geo': punches.some((p: any) => p.geo_status === 'fora_area') ? 'FORA PDV' : 'OK',
        'Offline': punches.some((p: any) => p.is_offline) ? 'SIM' : 'NÃO',
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 12 }, { wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 20 },
      { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 8 }
    ];

    // Format 'Horas Trabalhadas' column as [h]:mm in Excel if possible
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let R = range.s.r + 1; R <= range.e.r; ++R) {
      const cellAddress = XLSX.utils.encode_cell({ r: R, c: 10 }); // Column K (10) is 'Horas Trabalhadas'
      if (ws[cellAddress]) {
        ws[cellAddress].z = '[h]:mm';
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Folha de Ponto");

    const empDivs = empId ? divergences.filter((d: any) => d.employee_id === empId) : divergences;
    if (empDivs.length > 0) {
      const divRows = empDivs.map((d: any) => ({
        'Data': formatDateValue(d.date, 'dd/MM/yyyy', ''),
        'Colaborador': d.employee_name,
        'Tipo': d.type === 'sem_registro' ? 'Sem Registro' : d.type === 'incompleto' ? 'Incompleto' : 'Fora PDV',
        'Descrição': d.description,
        'Severidade': d.severity === 'high' ? 'ALTA' : d.severity === 'medium' ? 'MÉDIA' : 'BAIXA',
      }));
      const wsDiv = XLSX.utils.json_to_sheet(divRows);
      wsDiv['!cols'] = [{ wch: 12 }, { wch: 30 }, { wch: 15 }, { wch: 40 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, wsDiv, "Divergências");
    }

    const fileName = `folha_ponto_${String(empName || 'Todos').replace(/\s+/g, '_')}_${startDate}_${endDate}.xlsx`;
    XLSX.writeFile(wb, fileName);
    toast({ title: "Exportação concluída!", description: fileName });
  }, [consolidated, divergences, startDate, endDate, toast]);

  const totalOvertime = records.reduce((s: number, r: any) => s + (parseFloat(r.overtime_hours) || 0), 0);
  const offlinePunches = appPunches.filter((p: any) => p.is_offline);
  const outsidePdv = appPunches.filter((p: any) => p.geo_status === 'fora_area');
  const highDivergences = filteredDivergences.filter((d: any) => d.severity === 'high');

  const periodLabel = useMemo(() => {
    switch (periodPreset) {
      case 'hoje': return 'Hoje';
      case 'semana': return 'Esta Semana';
      case 'mes': return 'Este Mês';
      case 'mes_anterior': return 'Mês Anterior';
      default: return 'Personalizado';
    }
  }, [periodPreset]);

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2"><Clock className="h-6 w-6 text-primary" /> Gestão de Ponto</h1>
            <p className="text-sm text-muted-foreground">Controle de jornada, divergências e exportação</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={() => exportEmployeeXLS(employeeFilter || undefined)} className="gap-2">
              <FileSpreadsheet className="h-4 w-4" /> Exportar XLS
            </Button>
            <Button variant="outline" onClick={openNewPunch} className="gap-2">
              <Wrench className="h-4 w-4" /> Ajuste Manual
            </Button>
            <Button onClick={() => setDialogOpen(true)} className="gap-2"><Plus className="h-4 w-4" /> Registrar Ponto</Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <Filter className="h-4 w-4 text-muted-foreground" />
          {([
            { key: 'hoje', label: 'Hoje', icon: Calendar },
            { key: 'semana', label: 'Semana', icon: CalendarDays },
            { key: 'mes', label: 'Mês', icon: CalendarRange },
            { key: 'mes_anterior', label: 'Mês Anterior', icon: CalendarRange },
            { key: 'personalizado', label: 'Personalizado', icon: CalendarDays },
          ] as const).map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              variant={periodPreset === key ? "default" : "outline"}
              size="sm"
              onClick={() => setPeriodPreset(key)}
              className="gap-1.5 text-xs"
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </Button>
          ))}
          {periodPreset === 'personalizado' && (
            <div className="flex gap-1 items-center">
              <Input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} className="w-36 h-8 text-xs" />
              <span className="text-xs text-muted-foreground">até</span>
              <Input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} className="w-36 h-8 text-xs" />
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
          <Select value={employeeFilter || "__all__"} onValueChange={v => setEmployeeFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="w-60"><SelectValue placeholder="Todos os colaboradores" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todos os colaboradores</SelectItem>
              {employees.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.full_name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Badge variant="outline" className="text-xs">
            {periodLabel}: {formatDateValue(startDate, 'dd/MM')} - {formatDateValue(endDate, 'dd/MM/yyyy')}
          </Badge>
          {employeeFilter && (
            <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={() => exportEmployeeXLS(employeeFilter)}>
              <Download className="h-3.5 w-3.5" /> Exportar Individual
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground font-medium">Relatório:</span>
          {([
            { key: 'todos' as const, label: 'Todos', icon: Clock },
            { key: 'horas_extras' as const, label: 'Horas Extras', icon: TrendingUp },
            { key: 'faltas' as const, label: 'Faltas / Horas Faltantes', icon: UserX },
          ]).map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              variant={reportType === key ? "default" : "outline"}
              size="sm"
              onClick={() => setReportType(key)}
              className="gap-1.5 text-xs"
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Card><CardContent className="p-3 text-center"><p className="text-xl font-bold text-foreground">{consolidated.length}</p><p className="text-[10px] text-muted-foreground">Dias Registrados</p></CardContent></Card>
          <Card><CardContent className="p-3 text-center"><p className="text-xl font-bold text-foreground">{appPunches.length}</p><p className="text-[10px] text-muted-foreground">Registros App</p></CardContent></Card>
          <Card><CardContent className="p-3 text-center"><p className="text-xl font-bold text-primary">{totalOvertime.toFixed(1)}h</p><p className="text-[10px] text-muted-foreground">Horas Extras</p></CardContent></Card>
          <Card className={highDivergences.length > 0 ? 'border-destructive/50' : ''}>
            <CardContent className="p-3 text-center">
              <p className="text-xl font-bold text-destructive">{highDivergences.length}</p>
              <p className="text-[10px] text-muted-foreground">Faltas / Sem Registro</p>
            </CardContent>
          </Card>
          <Card><CardContent className="p-3 text-center"><p className="text-xl font-bold text-primary">{offlinePunches.length}</p><p className="text-[10px] text-muted-foreground">Offline</p></CardContent></Card>
          <Card><CardContent className="p-3 text-center"><p className="text-xl font-bold text-accent-foreground">{outsidePdv.length}</p><p className="text-[10px] text-muted-foreground">Fora PDV</p></CardContent></Card>
        </div>

        {filteredDivergences.length > 0 && (
          <Card className="border-destructive/30">
            <CardHeader className="p-3 pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive" /> Divergências ({filteredDivergences.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0">
              <div className="max-h-48 overflow-y-auto space-y-1">
                {filteredDivergences.slice(0, 20).map((d: any, i: number) => {
                  const cfg = DIVERGENCE_ICONS[d.type] || DIVERGENCE_ICONS.sem_registro;
                  const DivIcon = cfg.icon;
                  return (
                    <div key={i} className="flex items-center gap-3 text-sm p-2 bg-muted/30 rounded-lg">
                      <DivIcon className={`h-4 w-4 flex-shrink-0 ${cfg.color}`} />
                      <div className="flex-1 min-w-0">
                        <span className="font-medium">{d.employee_name}</span>
                        <span className="text-muted-foreground mx-2">•</span>
                        <span className="text-xs text-muted-foreground">{formatDateValue(d.date, 'dd/MM/yyyy', '')}</span>
                      </div>
                      <span className="text-xs text-muted-foreground truncate max-w-48">{d.description}</span>
                      <Badge variant={d.severity === 'high' ? 'destructive' : d.severity === 'medium' ? 'secondary' : 'outline'} className="text-[10px]">
                        {d.severity === 'high' ? 'ALTA' : d.severity === 'medium' ? 'MÉDIA' : 'BAIXA'}
                      </Badge>
                    </div>
                  );
                })}
                {filteredDivergences.length > 20 && (
                  <p className="text-xs text-center text-muted-foreground py-1">+{filteredDivergences.length - 20} divergências</p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="validation" className="gap-2"><CheckCircle2 className="h-4 w-4" /> Validação diária</TabsTrigger>
            <TabsTrigger value="consolidated" className="gap-2"><CalendarDays className="h-4 w-4" /> Consolidado ({filteredConsolidated.length})</TabsTrigger>
            <TabsTrigger value="app" className="gap-2"><Smartphone className="h-4 w-4" /> App ({appPunches.length})</TabsTrigger>
            <TabsTrigger value="manual" className="gap-2"><Clock className="h-4 w-4" /> Manual ({filteredRecords.length})</TabsTrigger>
            <TabsTrigger value="overtime" className="gap-2">
              <ShieldAlert className="h-4 w-4" /> Horas Extras
              {overtimePendingCount > 0 && <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4 min-w-4">{overtimePendingCount}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="cartao" className="gap-2"><CalendarRange className="h-4 w-4" /> Cartão de Ponto</TabsTrigger>
          </TabsList>

          <TabsContent value="cartao">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2"><CalendarRange className="h-4 w-4 text-primary" /> Ficha individual de ponto</CardTitle>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
                  <div>
                    <Label className="text-xs">Colaborador *</Label>
                    <Select value={cartaoEmployee} onValueChange={setCartaoEmployee}>
                      <SelectTrigger><SelectValue placeholder="Selecione um colaborador" /></SelectTrigger>
                      <SelectContent>
                        {employees.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.full_name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Período</Label>
                    <Select value={cartaoPreset} onValueChange={(v) => setCartaoPreset(v as PeriodPreset)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mes">Mês atual</SelectItem>
                        <SelectItem value="mes_anterior">Mês anterior</SelectItem>
                        <SelectItem value="semana">Semana atual</SelectItem>
                        <SelectItem value="hoje">Hoje</SelectItem>
                        <SelectItem value="personalizado">Personalizado</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {cartaoPreset === 'personalizado' && (
                    <>
                      <div><Label className="text-xs">Início</Label><Input type="date" value={cartaoStart} onChange={e => setCartaoStart(e.target.value)} /></div>
                      <div><Label className="text-xs">Fim</Label><Input type="date" value={cartaoEnd} onChange={e => setCartaoEnd(e.target.value)} /></div>
                    </>
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={!cartao || loadingCartao}
                      onClick={() => { try { exportCartaoPontoPdf(cartao); } catch { toast({ title: "Não foi possível gerar o PDF", variant: "destructive" }); } }}
                    ><Download className="h-4 w-4" /> PDF</Button>
                    <Button
                      variant="outline"
                      disabled={!cartaoEmployee || periodCloseMut.isPending}
                      onClick={() => toggleCartaoPeriod(!cartao?.days.some((d: CartaoDay) => d.closed))}
                    >
                      {cartao?.days.some((d: CartaoDay) => d.closed) ? 'Reabrir mês' : 'Fechar mês'}
                    </Button>
                  </div>
                </div>
                {cartao?.warning && (
                  <p className="text-xs text-amber-600 flex items-start gap-1"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {cartao.warning}</p>
                )}
              </CardHeader>
              <CardContent className="p-0">
                {!cartaoEmployee ? (
                  <p className="text-sm text-muted-foreground text-center py-10">Selecione um colaborador para ver a ficha.</p>
                ) : loadingCartao ? (
                  <p className="text-sm text-muted-foreground text-center py-10">Carregando...</p>
                ) : !cartao?.days.length ? (
                  <p className="text-sm text-muted-foreground text-center py-10">Nenhum dia no período selecionado.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Dia</TableHead>
                        <TableHead>Prev. entrada</TableHead>
                        <TableHead>Prev. saída</TableHead>
                        <TableHead>Prev. jornada</TableHead>
                        <TableHead>Batidas</TableHead>
                        <TableHead></TableHead>
                        <TableHead className="text-right">Trabalhado</TableHead>
                        <TableHead className="text-right">Crédito</TableHead>
                        <TableHead className="text-right">Débito</TableHead>
                        <TableHead>Situação</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {cartao.days.map((day: CartaoDay) => {
                        const today = day.date === format(nowSaoPaulo(), "yyyy-MM-dd");
                        const rowBg = day.dayType === 'feriado' ? 'bg-purple-500/5'
                          : day.dayType === 'folga' ? 'bg-muted/30'
                          : day.dayType === 'ausencia' ? 'bg-sky-500/5'
                          : today ? 'bg-primary/5' : '';
                        const editada = day.punches.some((p) => p.source === 'manual');
                        return (
                          <TableRow key={day.date} className={rowBg}>
                            <TableCell className="font-medium whitespace-nowrap">{dayLabel(day)}</TableCell>
                            <TableCell>{day.schedule.entry || '--'}</TableCell>
                            <TableCell>{day.schedule.exit || '--'}</TableCell>
                            <TableCell>{day.expected}</TableCell>
                            <TableCell>
                              {day.punches.length
                                ? day.punches.map((p) => p.time ?? '--').join('  ')
                                : <span className="text-muted-foreground">--</span>}
                            </TableCell>
                            <TableCell>{editada && <Badge variant="outline" className="border-amber-500 text-amber-600 text-[10px]">corrigido</Badge>}</TableCell>
                            <TableCell className="text-right">{day.worked}</TableCell>
                            <TableCell className="text-right text-primary">{day.credit}</TableCell>
                            <TableCell className="text-right text-destructive">{day.debit}</TableCell>
                            <TableCell>
                              {day.closed
                                ? <Badge variant="outline" className="text-[10px]">Período fechado</Badge>
                                : statusLabel(day)}
                            </TableCell>
                            <TableCell>
                              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => openCartaoDay(day)} title={day.closed ? 'Período fechado — reabra o mês para corrigir' : 'Corrigir batidas'}>
                                <Pencil className="h-3 w-3" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
                {cartao && (
                  <div className="border-t p-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div className="flex gap-4">
                      <span>Trabalhado: <strong>{cartao.totals.worked}</strong></span>
                      <span className="text-muted-foreground">Esperado: <strong>{cartao.totals.expected}</strong></span>
                      <span className="text-primary">Crédito: <strong>{cartao.totals.credit}</strong></span>
                      <span className="text-destructive">Débito: <strong>{cartao.totals.debit}</strong></span>
                      <span className="text-muted-foreground">{cartao.totals.daysWorked} dias trabalhados</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Acumulado do ano (desde {cartao.yearToDate.from.split('-').reverse().join('/')}): <strong>{cartao.yearToDate.saldo}</strong>
                    </span>
                  </div>
                )}

                {cartao && cartao.monthBank && cartao.monthBank.length > 0 && (
                  <div className="border-t">
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      Banco de horas por mês — esperado calculado pela jornada, não por 220h fixos.
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Mês</TableHead>
                          <TableHead className="text-right">Dias</TableHead>
                          <TableHead className="text-right">Esperado</TableHead>
                          <TableHead className="text-right">Trabalhado</TableHead>
                          <TableHead className="text-right">Saldo</TableHead>
                          <TableHead>Situação</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {cartao.monthBank.map((m) => (
                          <TableRow key={m.reference_month}>
                            <TableCell className="font-medium">
                              {m.reference_month.split('-').reverse().join('/')}
                            </TableCell>
                            <TableCell className="text-right">
                              {m.daysWorked}/{m.daysWorked + m.daysAbsent}
                            </TableCell>
                            <TableCell className="text-right">{m.expected}</TableCell>
                            <TableCell className="text-right">{m.worked}</TableCell>
                            <TableCell className={cn(
                              "text-right font-medium",
                              m.status === 'banco' && "text-primary",
                              m.status === 'deficit' && "text-destructive",
                            )}>
                              {m.saldo}
                            </TableCell>
                            <TableCell>
                              <Badge variant={m.status === 'banco' ? 'default' : m.status === 'deficit' ? 'destructive' : 'secondary'}>
                                {m.status === 'banco' ? 'Banco de horas' : m.status === 'deficit' ? 'Déficit' : 'Em nível'}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="validation">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> Validação diária por funcionário</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader><TableRow><TableHead>Data</TableHead><TableHead>Colaborador</TableHead><TableHead>Realizado</TableHead><TableHead>Planejado</TableHead><TableHead>Saldo</TableHead><TableHead>Situação</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {loadingConsolidated ? <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Carregando...</TableCell></TableRow> : filteredConsolidated.length === 0 ? <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Nenhum registro encontrado</TableCell></TableRow> : filteredConsolidated.map((c: any, idx: number) => {
                      const punches = Array.isArray(c.punches) ? c.punches : [];
                      const incomplete = punches.length % 2 !== 0;
                      const realized = Number(c.total_minutes) || 0;
                      const hasSchedule = c.daily_hours !== null && c.daily_hours !== undefined;
                      const planned = hasSchedule ? Number(c.daily_hours) * 60 : 0;
                      const balance = realized - planned;
                      const balanceLabel = hasSchedule ? `${balance >= 0 ? '+' : '-'}${formatMinutesToHHMM(Math.abs(balance))}` : '—';
                      const status = incomplete ? 'Incompleto' : !hasSchedule ? 'Sem escala' : balance > 0 ? 'Hora extra' : balance < 0 ? 'Déficit' : 'Normal';
                      return <TableRow key={idx} className={incomplete ? 'bg-yellow-50/50 dark:bg-yellow-950/10' : ''}>
                        <TableCell>{formatDateValue(c.record_date, 'dd/MM/yyyy')}</TableCell><TableCell className="font-medium">{c.employee_name}</TableCell><TableCell>{c.formatted_hours || formatMinutesToHHMM(realized)}</TableCell><TableCell>{hasSchedule ? formatMinutesToHHMM(planned) : '—'}</TableCell><TableCell className={balance > 0 ? 'text-green-600 font-semibold' : balance < 0 ? 'text-red-600 font-semibold' : ''}>{incomplete ? '—' : balanceLabel}</TableCell><TableCell><Badge variant={incomplete ? 'secondary' : balance < 0 ? 'destructive' : 'outline'}>{status}</Badge></TableCell>
                      </TableRow>;
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="overtime">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-purple-600" /> Solicitações de Hora Extra
                </CardTitle>
              </CardHeader>
              <CardContent>
                <OvertimeRequestsPanel statusFilter="all" />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="consolidated">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data</TableHead>
                      <TableHead>Colaborador</TableHead>
                      <TableHead>Entrada</TableHead>
                      <TableHead className="hidden md:table-cell">Saída Int.</TableHead>
                      <TableHead className="hidden md:table-cell">Retorno</TableHead>
                      <TableHead>Saída</TableHead>
                      <TableHead>Horas</TableHead>
                      <TableHead>Registros</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loadingConsolidated ? (
                      <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Carregando...</TableCell></TableRow>
                    ) : filteredConsolidated.length === 0 ? (
                      <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Nenhum registro encontrado para o filtro selecionado</TableCell></TableRow>
                    ) : filteredConsolidated.map((c: any, idx: number) => {
                      const punches = Array.isArray(c.punches) ? c.punches : [];
                      const entrada = punches.find((p: any) => p.punch_type === 'entrada');
                      const saidaInt = punches.find((p: any) => p.punch_type === 'saida_intervalo');
                      const retorno = punches.find((p: any) => p.punch_type === 'retorno_intervalo');
                      const saida = punches.find((p: any) => p.punch_type === 'saida');
                      const hasGeoIssue = punches.some((p: any) => p.geo_status === 'fora_area');
                      const isIncomplete = punches.length % 2 !== 0;
                      const hours = c.formatted_hours || (c.total_minutes ? formatMinutesToHHMM(c.total_minutes) : '—');

                      return (
                        <TableRow key={idx} className={isIncomplete ? 'bg-yellow-50/50 dark:bg-yellow-950/10' : hasGeoIssue ? 'bg-orange-50/50 dark:bg-orange-950/10' : ''}>
                          <TableCell className="font-medium text-sm">
                            {formatDateValue(c.record_date, 'dd/MM/yyyy')}
                          </TableCell>
                          <TableCell className="text-sm">{c.employee_name}</TableCell>
                          <TableCell className="text-sm">{formatDateValue(getPunchTimestamp(entrada), 'HH:mm')}</TableCell>
                          <TableCell className="hidden md:table-cell text-sm">{formatDateValue(getPunchTimestamp(saidaInt), 'HH:mm')}</TableCell>
                          <TableCell className="hidden md:table-cell text-sm">{formatDateValue(getPunchTimestamp(retorno), 'HH:mm')}</TableCell>
                          <TableCell className="text-sm">{formatDateValue(getPunchTimestamp(saida), 'HH:mm')}</TableCell>
                          <TableCell className="font-medium text-sm">{hours}</TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Badge variant="outline" className="text-[10px]">{c.punch_count}x</Badge>
                              {isIncomplete && <Badge variant="secondary" className="text-[10px]">⚠ Ímpar</Badge>}
                              {hasGeoIssue && <Badge variant="destructive" className="text-[10px]">Fora PDV</Badge>}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs gap-1"
                              onClick={() => exportEmployeeXLS(c.employee_id)}
                            >
                              <Download className="h-3 w-3" /> XLS
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="app">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data/Hora</TableHead>
                      <TableHead>Colaborador</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead className="hidden md:table-cell">PDV</TableHead>
                      <TableHead>Geo</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loadingPunches ? (
                      <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Carregando...</TableCell></TableRow>
                    ) : appPunches.length === 0 ? (
                      <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Nenhum registro do app encontrado</TableCell></TableRow>
                    ) : appPunches.map((p: any) => (
                      <TableRow key={p.id} className={p.manual_adjustment ? 'bg-amber-50/40 dark:bg-amber-950/10' : ''}>
                        <TableCell className="font-medium text-sm">
                          {formatDateValue(getPunchTimestamp(p), 'dd/MM/yyyy HH:mm:ss', 'Pendente')}
                        </TableCell>
                        <TableCell>{p.employee_name}</TableCell>
                        <TableCell>
                          <span className="text-sm">{PUNCH_LABELS[p.punch_type] || p.punch_type}</span>
                          {p.manual_adjustment && (
                            <Badge variant="outline" className="ml-1 text-[10px] border-amber-500 text-amber-700" title={p.adjustment_reason || ''}>
                              <Wrench className="h-3 w-3 mr-1" />Manual
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs">
                          {p.pdv_name ? <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{p.pdv_name}</span> : "—"}
                        </TableCell>
                        <TableCell>
                          {p.geo_status && GEO_LABELS[p.geo_status] ? (
                            <Badge variant={GEO_LABELS[p.geo_status].variant} className="text-[10px]">
                              {p.geo_status === 'dentro_area' ? <CheckCircle2 className="h-3 w-3 mr-1" /> : p.geo_status === 'fora_area' ? <AlertTriangle className="h-3 w-3 mr-1" /> : null}
                              {GEO_LABELS[p.geo_status].label}
                            </Badge>
                          ) : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {p.is_offline ? (
                              <Badge variant="outline" className="text-[10px]"><WifiOff className="h-3 w-3 mr-1" />Offline</Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px]"><Wifi className="h-3 w-3 mr-1" />Online</Badge>
                            )}
                            <Badge variant={p.sync_status === 'synced' ? 'default' : 'secondary'} className="text-[10px]">
                              {p.sync_status === 'synced' ? '✓ Sync' : '⏳ Pendente'}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEditPunch(p)} title="Ajustar marcação">
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => removePunch(p)} title="Remover">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="manual">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data</TableHead>
                      <TableHead>Colaborador</TableHead>
                      <TableHead className="hidden md:table-cell">Entrada</TableHead>
                      <TableHead className="hidden md:table-cell">Almoço</TableHead>
                      <TableHead className="hidden md:table-cell">Retorno</TableHead>
                      <TableHead className="hidden md:table-cell">Saída</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>HE</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Carregando...</TableCell></TableRow>
                    ) : filteredRecords.length === 0 ? (
                      <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Nenhum registro encontrado para o filtro selecionado</TableCell></TableRow>
                    ) : filteredRecords.map((r: any) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{formatDateValue(r.record_date, 'dd/MM/yyyy')}</TableCell>
                        <TableCell>{r.employee_name}</TableCell>
                        <TableCell className="hidden md:table-cell">{r.entry1 || "—"}</TableCell>
                        <TableCell className="hidden md:table-cell">{r.exit1 || "—"}</TableCell>
                        <TableCell className="hidden md:table-cell">{r.entry2 || "—"}</TableCell>
                        <TableCell className="hidden md:table-cell">{r.exit2 || "—"}</TableCell>
                        <TableCell className="font-medium">{r.total_hours ? formatMinutesToHHMM(Math.round(r.total_hours * 60)) : "—"}</TableCell>
                        <TableCell>{parseFloat(r.overtime_hours) > 0 ? <Badge variant="outline" className="text-primary">{formatMinutesToHHMM(Math.round(r.overtime_hours * 60))}</Badge> : "—"}</TableCell>
                        <TableCell><Badge variant="outline">{STATUS_LABELS[r.status] || r.status}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Registrar Ponto</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Colaborador *</Label>
              <Select value={form.employee_id} onValueChange={v => setField("employee_id", v)}>
                <SelectTrigger><SelectValue placeholder="Selecionar" /></SelectTrigger>
                <SelectContent>
                  {employees.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.full_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Data *</Label><Input type="date" value={form.record_date} onChange={e => setField("record_date", e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Entrada</Label><Input type="time" value={form.entry1} onChange={e => setField("entry1", e.target.value)} /></div>
              <div><Label>Saída Almoço</Label><Input type="time" value={form.exit1} onChange={e => setField("exit1", e.target.value)} /></div>
              <div><Label>Retorno</Label><Input type="time" value={form.entry2} onChange={e => setField("entry2", e.target.value)} /></div>
              <div><Label>Saída</Label><Input type="time" value={form.exit2} onChange={e => setField("exit2", e.target.value)} /></div>
            </div>
            <div><Label>Status</Label>
              <Select value={form.status} onValueChange={v => setField("status", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(STATUS_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Justificativa</Label><Input value={form.justification} onChange={e => setField("justification", e.target.value)} /></div>
            <div className="text-sm text-muted-foreground">Total calculado: <strong>{formatMinutesToHHMM(calcMinutes(form))}</strong></div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={saveMut.isPending}>{saveMut.isPending ? "Salvando..." : "Salvar"}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cartaoDialogOpen} onOpenChange={setCartaoDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-amber-600" />
              Corrigir batidas — {cartaoForm.date.split('-').reverse().join('/')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {cartaoForm.locked && (
              <p className="text-sm text-destructive flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                Período fechado. Reabra o mês para corrigir este dia.
              </p>
            )}
            <div>
              <Label>Batidas do dia</Label>
              <div className="space-y-2 mt-1">
                {cartaoForm.times.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Badge variant="outline" className="w-32 justify-center text-[10px]">
                      {cartaoForm.times.length === 1
                        ? 'Entrada / saída'
                        : i === 0 ? 'Entrada' : i === cartaoForm.times.length - 1 ? 'Saída' : i % 2 === 1 ? 'Saída intervalo' : 'Retorno'}
                    </Badge>
                    <Input
                      type="time" step="1" value={t} disabled={cartaoForm.locked}
                      onChange={e => setCartaoForm(f => {
                        const times = [...f.times];
                        times[i] = e.target.value;
                        return { ...f, times };
                      })}
                    />
                    <Button
                      variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={cartaoForm.locked || cartaoForm.times.length <= 1}
                      onClick={() => setCartaoForm(f => ({ ...f, times: f.times.filter((_, idx) => idx !== i) }))}
                    ><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
              </div>
              <Button
                variant="outline" size="sm" className="mt-2" disabled={cartaoForm.locked || cartaoForm.times.length >= 8}
                onClick={() => setCartaoForm(f => ({ ...f, times: [...f.times, ''] }))}
              ><Plus className="h-3.5 w-3.5" /> Adicionar batida</Button>
              <p className="text-[11px] text-muted-foreground mt-1">O tipo de cada batida é definido pela ordem: a primeira é entrada e a última é saída.</p>
            </div>
            <div>
              <Label>Motivo da correção *</Label>
              <Textarea
                rows={3} placeholder="Ex.: esquecimento do colaborador, falha do totem..."
                value={cartaoForm.reason} disabled={cartaoForm.locked}
                onChange={e => setCartaoForm(f => ({ ...f, reason: e.target.value }))}
              />
            </div>
            {cartaoAudit.length > 0 && (
              <div>
                <Label>Histórico deste dia</Label>
                <div className="mt-1 space-y-1 max-h-32 overflow-y-auto">
                  {cartaoAudit.map((a) => (
                    <div key={a.id} className="text-[11px] text-muted-foreground border rounded p-2">
                      <div className="flex justify-between gap-2">
                        <span>{a.old_value || '--'} → <b>{a.new_value || '--'}</b></span>
                        <span>{a.editor_name || 'sistema'}</span>
                      </div>
                      <div>{formatDateValue(a.created_at, 'dd/MM/yyyy HH:mm')}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setCartaoDialogOpen(false)}>Fechar</Button>
            <Button onClick={saveCartaoDay} disabled={cartaoForm.locked || cartaoUpdateMut.isPending}>
              {cartaoUpdateMut.isPending ? 'Salvando...' : 'Salvar correção'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={punchDialogOpen} onOpenChange={setPunchDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-amber-600" />
              {punchForm.id ? 'Ajustar Marcação' : 'Registrar Ponto Manual'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Colaborador *</Label>
              <Select value={punchForm.employee_id} onValueChange={v => setPunchForm((f: any) => ({ ...f, employee_id: v }))} disabled={!!punchForm.id}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  {employees.map(e => <SelectItem key={e.id} value={e.id}>{e.full_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tipo *</Label>
              <Select value={punchForm.punch_type} onValueChange={v => setPunchForm((f: any) => ({ ...f, punch_type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PUNCH_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label>Data *</Label><Input type="date" value={punchForm.date} onChange={e => setPunchForm((f: any) => ({ ...f, date: e.target.value }))} /></div>
              <div><Label>Hora *</Label><Input type="time" step="1" value={punchForm.time} onChange={e => setPunchForm((f: any) => ({ ...f, time: e.target.value }))} /></div>
            </div>
            <div>
              <Label>Motivo do ajuste *</Label>
              <Input placeholder="Ex.: esquecimento do colaborador, falha do totem..." value={punchForm.adjustment_reason} onChange={e => setPunchForm((f: any) => ({ ...f, adjustment_reason: e.target.value }))} />
              <p className="text-[11px] text-muted-foreground mt-1">Esta marcação ficará sinalizada como <b>Manual</b> na auditoria.</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setPunchDialogOpen(false)}>Cancelar</Button>
            <Button onClick={savePunch} disabled={createPunchMut.isPending || updatePunchMut.isPending}>
              {(createPunchMut.isPending || updatePunchMut.isPending) ? 'Salvando...' : 'Salvar'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
