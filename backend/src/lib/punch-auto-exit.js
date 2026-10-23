// Saída automática do ponto para tenants com "controle de ponto pelo check-in".
//
// Regra (pedido do cliente):
// - 30 min antes do fim da jornada: se houver rota ativa (in_progress), só
//   avisa o promotor (notificação) para fazer checkout + bater o ponto;
// - no fim da jornada: sem rota ativa, registra a SAÍDA automaticamente —
//   pelo último checkout do dia quando existir, ou pela última foto registrada
//   na rota (com anotação "ponto batido — última foto registrada") quando o
//   promotor esqueceu o checkout.
// - Idempotente: no máximo uma saída automática por dia; nunca quebra o cron.

import { query } from '../db.js';
import { logWarn, logInfo } from '../logger.js';
import { resolveDaySchedule, normalizeDow } from './work-schedule.js';
import { PUNCH_ON_CHECKIN_SETTING_KEY } from './punch-on-checkin-config.js';

const EXCLUDED_TYPES = ['pj', 'freelance', 'freelancer'];

async function orgsWithAutoPunch() {
  try {
    const r = await query(
      `SELECT organization_id FROM organization_settings
        WHERE setting_key = $1 AND (config->>'enabled') = 'true'`,
      [PUNCH_ON_CHECKIN_SETTING_KEY]
    );
    return r.rows.map((x) => x.organization_id);
  } catch (e) {
    logWarn('punch_auto_exit.orgs_failed', { error: e?.message });
    return [];
  }
}

async function resolveExitForEmployee(emp) {
  // Escala recorrente (mesma precedência do app de ponto).
  let scale = null;
  try {
    const dowRes = await query(
      "SELECT EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int as dow"
    );
    const dayOfWeek = Number(dowRes.rows[0]?.dow ?? 0);
    const rec = await query(
      `SELECT ws.entry_time, ws.exit_time
         FROM employee_schedules es
         JOIN work_schedules ws ON ws.id = es.schedule_id
        WHERE es.employee_id = $1 AND es.active = true AND ws.active = true
          AND es.start_date <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          AND (es.end_date IS NULL OR es.end_date >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
        ORDER BY es.created_at DESC`,
      [emp.id]
    );
    const cur = rec.rows.find(
      (row) => !Array.isArray(row.workdays) || row.workdays.map(Number).includes(dayOfWeek)
    );
    if (cur?.entry_time && cur?.exit_time) {
      scale = { entry_time: cur.entry_time, exit_time: cur.exit_time };
    }
  } catch { /* sem tabela de escala — segue para jornada */ }

  const isoDowRes = await query(
    "SELECT EXTRACT(ISODOW FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int as dow"
  );
  const resolved = resolveDaySchedule({
    scale,
    employee: emp.work_schedule,
    organizationSchedule: emp.organization_work_schedule,
    isoDow: normalizeDow(Number(isoDowRes.rows[0]?.dow ?? 0)),
  });
  return resolved;
}

async function alreadyNotifiedToday(employeeId, referenceType) {
  const r = await query(
    `SELECT 1 FROM collaborator_notifications
      WHERE employee_id = $1 AND reference_type = $2
        AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      LIMIT 1`,
    [employeeId, referenceType]
  );
  return r.rows.length > 0;
}

async function notify(orgId, employeeId, title, message, referenceType) {
  if (await alreadyNotifiedToday(employeeId, referenceType)) return;
  await query(
    `INSERT INTO collaborator_notifications
       (organization_id, employee_id, title, message, type, reference_type)
     VALUES ($1,$2,$3,$4,'timesheet',$5)`,
    [orgId, employeeId, title, message, referenceType]
  );
}

export async function runPunchAutoExit() {
  const orgs = await orgsWithAutoPunch();
  for (const orgId of orgs) {
    let employees;
    try {
      employees = await query(
        `SELECT e.id, e.organization_id, e.employment_type, e.work_schedule,
                o.work_schedule AS organization_work_schedule
           FROM employees e
           JOIN organizations o ON o.id = e.organization_id
          WHERE e.organization_id = $1
            AND (e.active IS NULL OR e.active = true)`,
        [orgId]
      );
    } catch (e) {
      logWarn('punch_auto_exit.employees_failed', { error: e?.message, orgId });
      continue;
    }

    for (const emp of employees.rows) {
      try {
        const employmentType = String(emp.employment_type || 'clt').trim().toLowerCase();
        if (EXCLUDED_TYPES.includes(employmentType)) continue;

        // Só age para quem bateu entrada hoje e ainda não tem saída.
        const entrada = await query(
          `SELECT id FROM time_punches WHERE employee_id = $1 AND punch_type = 'entrada'
             AND (punched_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
           LIMIT 1`,
          [emp.id]
        );
        if (!entrada.rows.length) continue;
        const saida = await query(
          `SELECT id FROM time_punches WHERE employee_id = $1 AND punch_type = 'saida'
             AND (punched_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
           LIMIT 1`,
          [emp.id]
        );
        if (saida.rows.length) continue;

        const sched = await resolveExitForEmployee(emp);
        if (!sched.isWorkday || sched.exit == null) continue;

        const nowRes = await query(
          `SELECT EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int * 60
                  + EXTRACT(MINUTE FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int AS now_min`
        );
        const nowMin = Number(nowRes.rows[0]?.now_min ?? -1);
        if (nowMin < 0 || nowMin < sched.exit - 30) continue;

        const active = await query(
          `SELECT id FROM merch_routes
            WHERE promoter_id = $1
              AND visit_date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
              AND status = 'in_progress'
            LIMIT 1`,
          [emp.id]
        );

        // Janela de aviso (30 min antes): com rota ativa, só notifica.
        if (nowMin < sched.exit) {
          if (active.rows.length) {
            await notify(
              orgId, emp.id,
              'Fim da jornada se aproximando',
              'Sua jornada termina em breve. Finalize a loja (checkout) e bata o ponto de saída no relógio.',
              'punch_exit_warn'
            );
          }
          continue;
        }

        // Chegou a hora da saída.
        if (active.rows.length) {
          // Rota ainda aberta: pede checkout + ponto manual (não fabrica saída).
          await notify(
            orgId, emp.id,
            'Hora de encerrar a jornada',
            'Sua jornada terminou e há rota em andamento. Faça o checkout da loja e bata o ponto de saída.',
            'punch_exit_due'
          );
          continue;
        }

        // Sem rota ativa: último checkout do dia vira a saída.
        const lastCheckout = await query(
          `SELECT checkout_at AS at, checkout_latitude AS lat, checkout_longitude AS lng, pdv_id
             FROM merch_routes
            WHERE promoter_id = $1
              AND visit_date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
              AND checkout_at IS NOT NULL
            ORDER BY checkout_at DESC LIMIT 1`,
          [emp.id]
        );
        // Sem checkout (esqueceu): última foto registrada na rota.
        const lastPhoto = await query(
          `SELECT rp.captured_at AS at, rp.latitude AS lat, rp.longitude AS lng, r.pdv_id
             FROM route_photos rp
             JOIN merch_routes r ON r.id = rp.route_id
            WHERE r.promoter_id = $1
              AND r.visit_date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
            ORDER BY rp.captured_at DESC LIMIT 1`,
          [emp.id]
        );

        const co = lastCheckout.rows[0];
        const ph = lastPhoto.rows[0];
        let chosen = null;
        let justification = null;
        if (co) {
          chosen = co;
          justification = 'Saída automática pelo checkout da loja (fim da jornada)';
        } else if (ph) {
          chosen = ph;
          justification = 'Saída automática — ponto batido pela última foto registrada';
        }
        if (!chosen) continue; // sem evidência do dia: não fabrica ponto

        await query(
          `INSERT INTO time_punches (organization_id, employee_id, punch_type, punched_at,
              latitude, longitude, pdv_id, geo_status, sync_status, source, justification)
           VALUES ($1,$2,'saida',$3,$4,$5,$6,'dentro_area','synced','auto',$7)`,
          [orgId, emp.id, chosen.at, chosen.lat ?? null, chosen.lng ?? null,
           chosen.pdv_id ?? null, justification]
        );
        await notify(
          orgId, emp.id,
          'Ponto de saída registrado',
          justification + '.',
          'punch_exit_auto'
        );
        logInfo('punch_auto_exit.saida', { employee_id: emp.id, via: co ? 'checkout' : 'foto' });
      } catch (e) {
        logWarn('punch_auto_exit.employee_failed', { error: e?.message, employee_id: emp?.id });
      }
    }
  }
}
