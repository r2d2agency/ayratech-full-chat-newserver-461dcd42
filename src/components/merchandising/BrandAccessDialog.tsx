import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, KeyRound, Plus, Trash2, RefreshCw, Copy, Check, MessageCircle } from "lucide-react";
import { useOrganizations } from "@/hooks/use-organizations";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  brand: { id: string; name: string; email?: string; responsible?: string } | null;
}

function genPassword() {
  const letters = "abcdefghjkmnpqrstuvwxyz";
  const nums = "23456789";
  const n = Array.from({ length: 3 }, () => nums[Math.floor(Math.random() * nums.length)]).join("");
  const l = Array.from({ length: 2 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  return `ayra${n}${l}`;
}

export function BrandAccessDialog({ open, onOpenChange, brand }: Props) {
  const { user } = useAuth();
  const { getMembers, addMember, removeMember, updateMemberPassword } = useOrganizations();
  const orgId = user?.organization_id || sessionStorage.getItem("user_org_id") || "";

  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [lastCreds, setLastCreds] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const portalUrl = `https://access.ayratech.app/marca?m=${brand?.id || ""}&n=${encodeURIComponent(brand?.name || "")}`;

  const load = async () => {
    if (!orgId || !brand) return;
    setLoading(true);
    try {
      const all = await getMembers(orgId);
      setMembers((all || []).filter((m: any) => m.brand_id === brand.id));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && brand) {
      setForm({ name: brand.responsible || "", email: brand.email || "", password: genPassword() });
      setLastCreds(null);
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, brand?.id]);

  const handleCreate = async () => {
    if (!brand) return;
    if (!form.name.trim() || !form.email.trim() || form.password.length < 6) {
      toast.error("Nome, e-mail e senha (mín. 6) são obrigatórios");
      return;
    }
    setCreating(true);
    try {
      const res = await addMember(orgId, {
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
        role: "agent",
        brand_id: brand.id,
      });
      if (!res?.success) throw new Error("Não foi possível criar o acesso");
      toast.success("Acesso liberado");
      setLastCreds({ email: form.email.trim().toLowerCase(), password: form.password });
      setForm({ name: "", email: "", password: genPassword() });
      load();
    } catch (e: any) {
      toast.error(e?.message || "Erro ao liberar acesso");
    } finally {
      setCreating(false);
    }
  };

  const handleReset = async (m: any) => {
    const newPass = genPassword();
    if (!confirm(`Gerar nova chave de acesso para ${m.email}?\n\nNova senha: ${newPass}`)) return;
    const ok = await updateMemberPassword(orgId, m.user_id, newPass);
    if (ok) {
      setLastCreds({ email: m.email, password: newPass });
      toast.success("Chave de acesso atualizada");
    } else {
      toast.error("Erro ao atualizar a senha");
    }
  };

  const handleDelete = async (m: any) => {
    if (!confirm(`Revogar o acesso de ${m.email}?`)) return;
    const ok = await removeMember(orgId, m.user_id);
    if (ok) {
      toast.success("Acesso revogado");
      load();
    } else {
      toast.error("Erro ao revogar acesso");
    }
  };

  const credsText = lastCreds
    ? `Portal do Cliente — ${brand?.name}\nLink: ${portalUrl}\nE-mail: ${lastCreds.email}\nChave de acesso: ${lastCreds.password}`
    : "";

  const copyCreds = async () => {
    try {
      await navigator.clipboard.writeText(credsText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("Credenciais copiadas");
    } catch {
      toast.error("Não foi possível copiar");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            Liberar Acesso — {brand?.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <Label className="text-xs">Link do Portal do Cliente</Label>
            <div className="flex gap-2">
              <Input readOnly value={portalUrl} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                title="Copiar link"
                onClick={() => { navigator.clipboard.writeText(portalUrl); toast.success("Link copiado"); }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              A marca entra por este link e vê apenas o dashboard dela, conforme as permissões definidas na edição da marca.
            </p>
          </div>

          {lastCreds && (
            <div className="rounded-lg border-2 border-primary/40 bg-primary/5 p-3 space-y-2">
              <div className="text-sm font-semibold">Credenciais geradas</div>
              <div className="text-xs space-y-0.5">
                <div><b>E-mail:</b> {lastCreds.email}</div>
                <div><b>Chave:</b> <code className="bg-background px-1 py-0.5 rounded">{lastCreds.password}</code></div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={copyCreds}>
                  {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                  Copiar
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(credsText)}`, "_blank")}
                >
                  <MessageCircle className="h-3 w-3 mr-1" /> WhatsApp
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-lg border p-3 space-y-3">
            <div className="text-sm font-semibold flex items-center gap-2"><Plus className="h-4 w-4" /> Novo acesso</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Nome do responsável *</Label>
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex: João Silva" />
              </div>
              <div>
                <Label className="text-xs">E-mail de login *</Label>
                <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="cliente@marca.com" />
              </div>
              <div className="sm:col-span-2">
                <Label className="text-xs">Chave de acesso (senha) *</Label>
                <div className="flex gap-2">
                  <Input value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} className="font-mono" />
                  <Button type="button" variant="outline" size="icon" title="Gerar nova chave" onClick={() => setForm(f => ({ ...f, password: genPassword() }))}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
            <Button onClick={handleCreate} disabled={creating} size="sm">
              {creating && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Liberar acesso
            </Button>
          </div>

          <div>
            <div className="text-sm font-semibold mb-2">Acessos desta marca</div>
            {loading ? (
              <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : members.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-6">Nenhum acesso liberado ainda</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>E-mail</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[120px] text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((m: any) => (
                    <TableRow key={m.user_id}>
                      <TableCell className="font-medium">{m.name}</TableCell>
                      <TableCell className="text-xs">{m.email}</TableCell>
                      <TableCell>
                        <Badge variant={m.is_active === false ? "secondary" : "default"}>
                          {m.is_active === false ? "Inativo" : "Ativo"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" title="Gerar nova chave" onClick={() => handleReset(m)}>
                            <RefreshCw className="h-4 w-4 text-primary" />
                          </Button>
                          <Button size="icon" variant="ghost" title="Revogar acesso" onClick={() => handleDelete(m)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
