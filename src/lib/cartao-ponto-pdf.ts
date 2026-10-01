import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { CartaoPonto, CartaoDay } from '@/hooks/use-rh';

// O PDF consome exatamente os dados que a tela exibe: nada é recalculado aqui.
// Se a grade mudou, o PDF muda junto, porque os dois leem o mesmo objeto.

const DOW_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function dayLabel(day: CartaoDay) {
  const dow = day.isoDow ? DOW_LABELS[day.isoDow - 1] : '';
  const [, m, d] = day.date.split('-');
  return `${dow} ${d}/${m}`;
}

// Batidas em ordem, com o horário de São Paulo que o backend já entregou.
function timesCell(day: CartaoDay) {
  if (!day.punches.length) return '--';
  return day.punches.map((p) => p.time ?? '--').join('  ');
}

function typeMarker(day: CartaoDay) {
  if (day.punches.some((p) => p.source === 'manual')) return 'corrigido';
  if (day.punches.length) return '';
  return '';
}

function statusCell(day: CartaoDay) {
  if (day.dayType === 'feriado') return day.holidayName || 'Feriado';
  if (day.dayType === 'ausencia') return day.absenceType || 'Afastado';
  if (day.dayType === 'folga') return 'Folga';
  if (day.closed) return 'Período fechado';
  return '';
}

function typeStyles(day: CartaoDay) {
  if (day.dayType === 'feriado') return { fillColor: [250, 245, 255] as [number, number, number] };
  if (day.dayType === 'ausencia') return { fillColor: [239, 246, 255] as [number, number, number] };
  if (day.dayType === 'folga') return { fillColor: [243, 244, 246] as [number, number, number] };
  return undefined;
}

export function exportCartaoPontoPdf(data: CartaoPonto) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const margin = 12;
  let y = margin;

  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.text('Cartão de Ponto', margin, y);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(data.employee.full_name, margin, y + 6);
  const sub = [data.employee.position, data.employee.cpf ? `CPF ${data.employee.cpf}` : null]
    .filter(Boolean)
    .join('  |  ');
  doc.setFontSize(8);
  doc.setTextColor(90);
  doc.text(sub, margin, y + 11);
  doc.text(
    `Período: ${data.period.start.split('-').reverse().join('/')} a ${data.period.end.split('-').reverse().join('/')}`,
    margin,
    y + 16,
  );
  doc.setTextColor(0);
  y += 24;

  const body = data.days.map((day) => [
    dayLabel(day),
    day.schedule.entry,
    day.schedule.exit,
    day.expected,
    timesCell(day),
    typeMarker(day),
    day.worked,
    day.credit,
    day.debit,
    statusCell(day),
  ]);

  const tableStart = y;
  autoTable(doc, {
    startY: tableStart,
    margin: { left: margin, right: margin },
    head: [['Dia', 'Prev. entrada', 'Prev. saída', 'Prev. jornada', 'Batidas', '', 'Trabalhado', 'Crédito', 'Débito', 'Situação']],
    body,
    styles: { fontSize: 7.5, cellPadding: 1.4 },
    headStyles: { fillColor: [30, 30, 46], textColor: 255, fontStyle: 'bold', fontSize: 7.5, halign: 'center' },
    alternateRowStyles: { fillColor: [250, 250, 252] },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 18, halign: 'center' },
      2: { cellWidth: 18, halign: 'center' },
      3: { cellWidth: 20, halign: 'center' },
      4: { cellWidth: 58, halign: 'center' },
      5: { cellWidth: 16, halign: 'center', textColor: [180, 83, 9] },
      6: { cellWidth: 20, halign: 'center' },
      7: { cellWidth: 18, halign: 'center' },
      8: { cellWidth: 18, halign: 'center' },
      9: { cellWidth: 40 },
    },
    // A linha de cada dia herda a cor do seu tipo, para o papel bater com a tela.
    didParseCell: (hookData) => {
      const day = data.days[hookData.section === 'body' ? hookData.row.index : -1];
      const style = day ? typeStyles(day) : undefined;
      if (style) hookData.cell.styles.fillColor = style.fillColor;
    },
    foot: [[
      '',
      '',
      '',
      '',
      'TOTAIS',
      '',
      data.totals.worked,
      data.totals.credit,
      data.totals.debit,
      `${data.totals.daysWorked} dias trabalhados`,
    ]],
    footStyles: { fillColor: [235, 235, 242], textColor: 0, fontStyle: 'bold', fontSize: 7.5, halign: 'center' },
  });

  const lastY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(
    `Esperado no periodo: ${data.totals.expected}  |  `
    + `Acumulado do ano (desde ${data.yearToDate.from.split('-').reverse().join('/')}): `
    + `${data.yearToDate.saldo} h`,
    margin,
    lastY + 8,
  );
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120);
  doc.text(
    `Emitido em ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date())}`
    + '  |  Horários em America/Sao_Paulo',
    margin,
    lastY + 13,
  );

  // Banco de horas por mes. O saldo legal e mensal, e o esperado vem da
  // jornada -- nao de 220h fixos -- entao o gestor precisa ver a conta aberta
  // no impresso, igual a tela.
  y = lastY + 20;
  if (data.monthBank && data.monthBank.length) {
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0);
    doc.text('Banco de horas por mês', margin, y);
    y += 4;

    (doc as unknown as { autoTable: (o: unknown) => void }).autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Mês', 'Dias', 'Esperado', 'Trabalhado', 'Saldo', 'Situação']],
      body: data.monthBank.map((m) => [
        m.reference_month.split('-').reverse().join('/'),
        `${m.daysWorked}/${m.daysWorked + m.daysAbsent}`,
        m.expected,
        m.worked,
        m.saldo,
        m.status === 'banco' ? 'Banco de horas' : m.status === 'deficit' ? 'Déficit' : 'Em nível',
      ]),
      styles: { fontSize: 7.5, halign: 'center' },
      headStyles: { fillColor: [240, 240, 246], fontStyle: 'bold' },
      columnStyles: { 0: { halign: 'left' }, 5: { halign: 'left' } },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5;
  }

  doc.setTextColor(120);

  const slug = (data.employee.full_name || 'colaborador')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');
  doc.save(`cartao-ponto-${slug}-${data.period.start}_${data.period.end}.pdf`);
}
