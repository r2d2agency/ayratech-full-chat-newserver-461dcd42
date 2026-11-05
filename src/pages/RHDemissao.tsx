import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, UserMinus, Calculator, ClipboardCheck, FileSignature, AlertTriangle } from "lucide-react";
import { useEmployee } from "@/hooks/use-rh";
import { useTerminationPreview, useCreateTermination } from "@/hooks/use-rh-flows";

const REASONS = [
  { code: "sem_justa_causa", label: "Sem justa causa (dispensa)", esocial: "02" },
  { code: "pedido_colaborador", label: "Pedido do colaborador", esocial: "07" },
  { code: "acordo_484a", label: "Acordo (art. 484-A, Lei 13.467)", esocial: "11" },
  { code: "fim_experiencia", label: "Fim de contrato de experiência", esocial: "02" },
  { code: "fim_exp_colaborador", label: "ENCERRAMENTO DO CONTRATO DE EXPERIÊNCIA PELO COLABORADOR", esocial: "07" },
  { code: "fim_exp_empresa", label: "ENCERRAMENTO DO CONTRATO DE EXPERIÊNCIA PELA EMPRESA", esocial: "02" },
  { code: "justa_causa", label: "Justa causa", esocial: "03" },
  { code: "aposentadoria", label: "Aposentadoria", esocial: "09" },
  { code: "morte", label: "Falecimento", esocial: "17" },
  { code: "pj_encerramento", label: "Encerramento contrato PJ", esocial: "05" },
];

// Modalidades sem cumprimento de aviso prévio
const NO_NOTICE_REASONS = ["fim_exp_colaborador", "fim_exp_empresa"];

const DEFAULT_CHECKLIST = [
  { key: "crachá", label: "Crachá / ID funcional", checked: false },
  { key: "uniforme", label: "Uniformes", checked: false },
  { key: "epi", label: "EPIs pendentes de devolução", checked: false },
  { key: "celular", label: "Celular corporativo", checked: false },
  { key: "notebook", label: "Notebook / equipamentos", checked: false },
  { key: "chaves", label: "Chaves e acessos físicos", checked: false },
  { key: "senhas", label: "Revogação de senhas e sistemas", checked: false },
  { key: "app", label: "Acesso ao app do colaborador", checked: false },
];

const STEPS = [
  { id: 1, title: "Motivo", icon: UserMinus },
  { id: 2, title: "Aviso prévio", icon: FileSignature },
  { id: 3, title: "Rescisão", icon: Calculator },
  { id: 4, title: "Devoluções", icon: ClipboardCheck },
];

export default function RHDemissao() {
  const { employeeId } = useParams();
  const navigate = useNavigate();
  const { data: emp } = useEmployee(employeeId);
  const preview = useTerminationPreview();
  const create = useCreateTermination();

  const [step, setStep] = useState(1);
  const [form, setForm] = useState<any>({
    reason_code: "sem_justa_causa",
    termination_date: new Date().toISOString().slice(0, 10),
    notice_type: "indenizado",
    notice_start: "",
    notice_end: "",
    last_worked_date: "",
    fgts_balance: "",
    other_credits: 0,
    other_debits: 0,
    notes: "",
  });
  const setField = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const [checklist, setChecklist] = useState(DEFAULT_CHECKLIST);
  const [calc, setCalc] = useState<any>(null);

  // Auto-calcular ao chegar no passo 3
  useEffect(() => {
    if (step !== 3 || !emp) return;
    preview.mutate({
      employee_id: emp.id,
      salary: emp.salary,
      admission_date: emp.admission_date,
      termination_date: form.termination_date,
      reason_code: form.reason_code,
      notice_type: form.notice_type,
      fgts_balance: Number(form.fgts_balance || 0),
    }, {
      onSuccess: (r) => {
        setCalc(r);
        setForm((f: any) => NO_NOTICE_REASONS.includes(f.reason_code)
          ? ({ ...f, ...r, notice_type: "dispensado", notice_start: "", notice_end: "", notice_indemnity: 0 })
          : ({ ...f, ...r }));
      },
    });
  }, [step, form.reason_code, form.notice_type, form.termination_date, form.fgts_balance, emp]);

  const goNext = () => setStep(s => Math.min(4, s + 1));
  const goPrev = () => setStep(s => Math.max(1, s - 1));

  async function finish() {
    if (!emp) return;
    try {
      const noNotice = NO_NOTICE_REASONS.includes(form.reason_code);
      await create.mutateAsync({
        employee_id: emp.id,
        termination_date: form.termination_date,
        reason_code: form.reason_code,
        notice_type: noNotice ? "dispensado" : form.notice_type,
        notice_start: noNotice ? null : (form.notice_start || null),
        notice_end: noNotice ? null : (form.notice_end || null),
        last_worked_date: form.last_worked_date || null,
        fgts_balance: Number(form.fgts_balance || 0),
        salary_balance: Number(form.salary_balance || 0),
        vacation_due: Number(form.vacation_due || 0),
        vacation_proportional: Number(form.vacation_proportional || 0),
        vacation_bonus: Number(form.vacation_bonus || 0),
        thirteenth_proportional: Number(form.thirteenth_proportional || 0),
        notice_indemnity: noNotice ? 0 : Number(form.notice_indemnity || 0),
        fgts_fine: Number(form.fgts_fine || 0),
        other_credits: Number(form.other_credits || 0),
        other_debits: Number(form.other_debits || 0),
        total_net: Number(form.total_net || 0),
        checklist,
        notes: form.notes,
      });
      toast.success("Demissão registrada. Evento S-2299 enfileirado no eSocial.");
      navigate("/rh/colaboradores");
    } catch (err: any) {
      toast.error(err?.message || "Erro ao processar demissão");
    }
  }

  if (!emp) return <div className="container py-8">Carregando colaborador…</div>;

  const fmt = (v: any) => `R$ ${Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const totalCalc = Number(form.salary_balance || 0) + Number(form.vacation_due || 0) + Number(form.vacation_proportional || 0) +
    Number(form.vacation_bonus || 0) + Number(form.thirteenth_proportional || 0) + Number(form.notice_indemnity || 0) +
    Number(form.fgts_fine || 0) + Number(form.other_credits || 0) - Number(form.other_debits || 0);

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2"><UserMinus className="h-8 w-8" /> Demissão</h1>
        <p className="text-muted-foreground">
          {emp.full_name} · CPF {emp.cpf} · Admissão {emp.admission_date?.slice(0, 10)} · Salário {fmt(emp.salary)}
        </p>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          {STEPS.map(s => {
            const Icon = s.icon;
            const done = step > s.id, active = step === s.id;
            return (
              <div key={s.id} className="flex flex-col items-center flex-1 text-center gap-1">
                <div className={`h-10 w-10 rounded-full flex items-center justify-center border-2 ${done ? "bg-primary text-primary-foreground border-primary" : active ? "border-primary text-primary" : "border-muted text-muted-foreground"}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <span className={`text-xs ${active ? "font-semibold" : "text-muted-foreground"}`}>{s.title}</span>
              </div>
            );
          })}
        </div>
        <Progress value={(step / 4) * 100} className="h-2" />
      </Card>

      {step === 1 && (
        <Card className="p-6 space-y-4">
          <h2 className="text-xl font-semibold">Motivo e data do desligamento</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div><Label>Motivo *</Label>
              <Select value={form.reason_code} onValueChange={v => setField("reason_code", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{REASONS.map(r => <SelectItem key={r.code} value={r.code}>{r.label}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">Código eSocial: {REASONS.find(r => r.code === form.reason_code)?.esocial}</p>
            </div>
            <div><Label>Data do desligamento *</Label><Input type="date" value={form.termination_date} onChange={e => setField("termination_date", e.target.value)} /></div>
          </div>
          {form.reason_code === "justa_causa" && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm flex gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <span>Justa causa exige documentação (advertências, sindicância). Sem direito a aviso, 13º e férias proporcionais, nem multa FGTS.</span>
            </div>
          )}
        </Card>
      )}

      {step === 2 && (
        <Card className="p-6 space-y-4">
          <h2 className="text-xl font-semibold">Aviso prévio</h2>
          {NO_NOTICE_REASONS.includes(form.reason_code) ? (
            <div className="rounded-lg border border-muted bg-muted/20 p-4 text-sm flex gap-2">
              <AlertTriangle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <span>O encerramento do contrato de experiência não exige cumprimento de aviso prévio. O aviso foi desabilitado automaticamente.</span>
            </div>
          ) : (
            <>
              <div><Label>Tipo *</Label>
                <Select value={form.notice_type} onValueChange={v => setField("notice_type", v)}>
                  <SelectTrigger className="max-w-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="indenizado">Indenizado (pago sem trabalhar)</SelectItem>
                    <SelectItem value="trabalhado">Trabalhado (cumprido no serviço)</SelectItem>
                    <SelectItem value="dispensado">Dispensado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid md:grid-cols-3 gap-4">
                <div><Label>Início do aviso</Label><Input type="date" value={form.notice_start} onChange={e => setField("notice_start", e.target.value)} /></div>
                <div><Label>Fim do aviso</Label><Input type="date" value={form.notice_end} onChange={e => setField("notice_end", e.target.value)} /></div>
                <div><Label>Último dia trabalhado</Label><Input type="date" value={form.last_worked_date} onChange={e => setField("last_worked_date", e.target.value)} /></div>
              </div>
              <p className="text-xs text-muted-foreground">Aviso proporcional: 30 dias + 3 dias por ano completo (Lei 12.506/2011), teto de 90 dias.</p>
            </>
          )}
        </Card>
      )}

      {step === 3 && (
        <Card className="p-6 space-y-4">
          <h2 className="text-xl font-semibold">Rescisão calculada</h2>
          <div className="rounded-lg bg-muted/40 p-4 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Motivo</span><span className="font-medium">{REASONS.find(r => r.code === form.reason_code)?.label}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Aviso prévio</span><span className="font-medium">{form.notice_type}</span></div>
          </div>
          <div><Label>Saldo do FGTS (informado pela Caixa)</Label>
            <Input type="number" step="0.01" value={form.fgts_balance} onChange={e => setField("fgts_balance", e.target.value)} placeholder="0.00" className="max-w-xs" />
            <p className="text-xs text-muted-foreground mt-1">Usado para calcular a multa (40% sem justa causa, 20% acordo).</p>
          </div>
          <Separator />
          <div className="grid md:grid-cols-2 gap-3 text-sm">
            {[
              ["salary_balance", "Saldo de salário"],
              ["vacation_due", "Férias vencidas"],
              ["vacation_proportional", "Férias proporcionais"],
              ["vacation_bonus", "1/3 constitucional"],
              ["thirteenth_proportional", "13º proporcional"],
              ["notice_indemnity", "Aviso indenizado"],
              ["fgts_fine", "Multa FGTS"],
              ["other_credits", "Outros créditos"],
              ["other_debits", "Descontos (débitos)"],
            ].map(([k, label]) => (
              <div key={k}>
                <Label>{label}</Label>
                <Input type="number" step="0.01" value={form[k] ?? 0} onChange={e => setField(k, e.target.value)} />
              </div>
            ))}
          </div>
          <div className="flex justify-between items-center pt-2 border-t">
            <span className="text-lg font-semibold">Total líquido</span>
            <span className="text-2xl font-bold text-primary">{fmt(totalCalc)}</span>
          </div>
        </Card>
      )}

      {step === 4 && (
        <Card className="p-6 space-y-4">
          <h2 className="text-xl font-semibold">Checklist de devoluções</h2>
          <div className="space-y-2">
            {checklist.map((item, i) => (
              <label key={item.key} className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/40">
                <Checkbox checked={item.checked} onCheckedChange={v => setChecklist(cl => cl.map((c, idx) => idx === i ? { ...c, checked: !!v } : c))} />
                <span className="flex-1">{item.label}</span>
                {item.checked && <Badge variant="secondary">OK</Badge>}
              </label>
            ))}
          </div>
          <div><Label>Observações / TRCT</Label><Textarea rows={3} value={form.notes} onChange={e => setField("notes", e.target.value)} placeholder="Notas internas, referência ao TRCT assinado, etc." /></div>
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm space-y-1">
            <div className="font-semibold text-primary">Ao clicar em "Finalizar desligamento":</div>
            <ul className="ml-6 list-disc text-muted-foreground">
              <li>Colaborador passa para status <b>desligado</b></li>
              <li>Rescisão é registrada com total {fmt(totalCalc)}</li>
              <li>Acesso ao app é revogado</li>
              <li>Evento <Badge variant="secondary">S-2299</Badge> é enfileirado no eSocial</li>
            </ul>
          </div>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={goPrev} disabled={step === 1}><ChevronLeft className="h-4 w-4 mr-1" /> Voltar</Button>
        {step < 4 ? (
          <Button onClick={goNext}>Próximo <ChevronRight className="h-4 w-4 ml-1" /></Button>
        ) : (
          <Button variant="destructive" onClick={finish} disabled={create.isPending}>
            {create.isPending ? "Processando..." : "Finalizar desligamento"}
          </Button>
        )}
      </div>
    </div>
  );
}
